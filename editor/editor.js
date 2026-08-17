import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/jsm/controls/TransformControls.js';
import { generateRightBranch, TernarySpatialWalshEngine } from './FractalBuilder.js';

// ============================================================
// 1. СОСТОЯНИЕ ПРИЛОЖЕНИЯ
// ============================================================
let graph = { nodes: [], edges: [] };
let nextId = 1;
let selectedNodes = [];
let selectedPart = null;
let undoStack = [], redoStack = [];
const MAX_UNDO = 30;
let clipboard = null;
let pythonTimeout = null;

// Виртуальный контейнер для управления группой выделенных объектов
const groupTransformProxy = new THREE.Group();
groupTransformProxy.name = "GIDEON_Group_Proxy";

// ============================================================
// 2. ЯДРО – РАБОТА С ГРАФОМ И СЕТЬ
// ============================================================
const walshEngine = new TernarySpatialWalshEngine();

function addNode(mode, x, y, z, params) {
    const id = nextId++;
    const node = {
        id,
        mode: mode || 'Single',
        x: x || 0,
        y: y || 0,
        z: z || 0,
        params: {
            N: params?.N || 5,
            target_len: params?.target_len || 1000,
            scale: params?.scale !== undefined ? params.scale : 1.0,
            stretch: params?.stretch !== undefined ? params.stretch : 1.0,
            angles: params?.angles ? [...params.angles] : [0, 0, 0], // 👈 ИЗМЕНЕНО НА НУЛИ ПО УМОЛЧАНИЮ
            showRight: params?.showRight !== undefined ? params.showRight : true,
            showS: params?.showS !== undefined ? params.showS : true,
            showLeft: params?.showLeft !== undefined ? params.showLeft : true,
            showSLeft: params?.showSLeft !== undefined ? params.showSLeft : true,
            rightSub: params?.rightSub || { height: 100, width: 100 },
            leftSub: params?.leftSub || { height: 100, width: 100 },
            sRightSub: params?.sRightSub || { height: 100, width: 100 },
            sLeftSub: params?.sLeftSub || { height: 100, width: 100 }
        },
        entryPoint: null,
        exitPoint: null,
        quantumState: { intensity: 0, psi_real: 0, psi_imag: 0 }
    };
    graph.nodes.push(node);
    return node;
}

function addEdge(fromId, toId, weight) {
    if (fromId === toId) return null;
    if (graph.edges.some(e => (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId))) return null;
    const edge = { from: fromId, to: toId, weight: weight !== undefined ? weight : 0.5 };
    graph.edges.push(edge);
    return edge;
}

function removeNode(id) {
    graph.nodes = graph.nodes.filter(n => n.id !== id);
    graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);
}

function getNode(id) { return graph.nodes.find(n => n.id === id); }

// ============================================================
// 3. ОНЛАЙН-МОСТ С PYTHON-ЯДРОМ
// ============================================================
async function sendDataToPythonCore() {
    const payload = {
        model_name: "GIDEON-Realtime-Session",
        total_nodes: graph.nodes.length,
        nodes: graph.nodes.map(n => ({
            id: n.id,
            x: n.x,
            y: n.y,
            z: n.z,
            params: n.params
        }))
    };

    try {
        const response = await fetch('http://localhost:8000', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (result.status === "success") {
            const consoleEl = document.getElementById('console');
            consoleEl.style.display = 'block';
            consoleEl.innerHTML = `<div class="line success">⚡ [Ядро онлайн]: Сфиралей: ${result.computed_nodes} | Хиральность: ${result.metrics.integral_chirality} (+${result.metrics.positive} / -${result.metrics.negative})</div>`;
        }
    } catch (err) {
        console.warn("⚠️ Локальное ядро не отвечает. Убедитесь, что запущен sfiral_server.py");
    }
}

const sendDataPythonCoreThrottled = () => {
    if (pythonTimeout) clearTimeout(pythonTimeout);
    pythonTimeout = setTimeout(() => sendDataToPythonCore(), 300);
};

// ============================================================
// 4. ТРЁХМЕРНАЯ СЦЕНА И РЕНДЕРИНГ
// ============================================================
const container = document.getElementById('canvasContainer');
const canvas = document.getElementById('renderCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const ambient = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambient);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
dirLight.position.set(1, 2, 1);
scene.add(dirLight);

const gridHelper = new THREE.GridHelper(1000, 20, 0x00e5ff, 0x1f2d4a);
gridHelper.rotation.x = 0;
scene.add(gridHelper);

const objectsGroup = new THREE.Group();
objectsGroup.name = "GIDEON_Fractal_Root_Container";
scene.add(objectsGroup);
scene.add(groupTransformProxy);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 5000);
camera.position.set(600, 400, 800);
camera.lookAt(0, 0, 0);
camera.up.set(0, 1, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);
controls.screenSpacePanning = true;
controls.update();

controls.mouseButtons = {
    LEFT: THREE.MOUSE.NONE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.ROTATE
};

const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.size = 0.8;
transformControls.space = 'local';
scene.add(transformControls);

let lastProxyPosition = new THREE.Vector3();
let lastProxyRotation = new THREE.Euler();

transformControls.addEventListener('dragging-changed', (event) => {
    controls.enabled = !event.value;
    if (event.value && selectedNodes.length > 1) {
        lastProxyPosition.copy(groupTransformProxy.position);
        lastProxyRotation.copy(groupTransformProxy.rotation);
    }
});

transformControls.addEventListener('change', () => {
    if (!transformControls.object) return;

    if (selectedNodes.length === 1) {
        const id = transformControls.object.userData.nodeId;
        const node = getNode(id);
        if (node) {
            node.x = transformControls.object.position.x;
            node.y = transformControls.object.position.y;
            node.z = transformControls.object.position.z;
            updateBottomBarValues(node);
            updateEdges();
        }
    } else if (selectedNodes.length > 1) {
        const deltaPos = new THREE.Vector3().subVectors(groupTransformProxy.position, lastProxyPosition);
        lastProxyPosition.copy(groupTransformProxy.position);

        const groupQuaternion = new THREE.Quaternion().setFromEuler(groupTransformProxy.rotation);
        const lastGroupQuaternion = new THREE.Quaternion().setFromEuler(lastProxyRotation);
        const deltaQuat = groupQuaternion.clone().multiply(lastGroupQuaternion.invert());
        lastProxyRotation.copy(groupTransformProxy.rotation);

        const center = new THREE.Vector3();
        selectedNodes.forEach(id => {
            const n = getNode(id);
            if (n) center.add(new THREE.Vector3(n.x, n.y, n.z));
        });
        center.divideScalar(selectedNodes.length);

        selectedNodes.forEach(id => {
            const node = getNode(id);
            const group = meshMap.get(id);
            if (!node || !group) return;

            if (transformControls.mode === 'translate') {
                node.x += deltaPos.x;
                node.y += deltaPos.y;
                node.z += deltaPos.z;
            } else if (transformControls.mode === 'rotate') {
                const v = new THREE.Vector3(node.x, node.y, node.z).sub(center);
                v.applyQuaternion(deltaQuat);
                v.add(center);
                node.x = v.x;
                node.y = v.y;
                node.z = v.z;

                group.rotation.setFromQuaternion(group.quaternion.premultiply(deltaQuat));
                node.params.angles = [
                    THREE.MathUtils.radToDeg(group.rotation.x),
                    THREE.MathUtils.radToDeg(group.rotation.y),
                    THREE.MathUtils.radToDeg(group.rotation.z)
                ];
            }
            updateNodeVisual(node);
        });
        updateEdges();
    }
});

transformControls.addEventListener('mouseUp', () => {
    saveState();
    updateStats();
    sendDataToPythonCore();
    if (selectedNodes.length > 1) {
        updateSelectionHighlights();
    }
});

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

function resizeRenderer() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeRenderer);

// ============================================================
// 5. ВИЗУАЛИЗАЦИЯ СФИРАЛЕЙ И РЁБЕР
// ============================================================
function applySubScale(pts, subParams, stretch = 1.0) {
    if (!subParams && stretch === 1.0) return pts;
    const scaleH = (subParams?.height !== undefined ? subParams.height : 100) / 100.0;
    const scaleW = (subParams?.width !== undefined ? subParams.width : 100) / 100.0;
    return pts.map(p => new THREE.Vector3(p.x * scaleW, p.y * scaleH, p.z * scaleW * stretch));
}

function createSfiralGroup(node) {
    const group = new THREE.Group();
    const nodeScale = node.params.scale !== undefined ? node.params.scale : 1.0;
    const stretch = node.params.stretch !== undefined ? node.params.stretch : 1.0;
    const R = (60 + node.params.N * 2) * nodeScale;
    const H = (80 + node.params.N * 2) * nodeScale;
    
    const rightBranch = generateRightBranch(R, H);
    const rightPts = applySubScale(rightBranch.mainPts, node.params.rightSub, stretch);
    const sRightPts = applySubScale(rightBranch.sPts, node.params.sRightSub, stretch);
    const leftBasePts = rightBranch.mainPts.map(p => new THREE.Vector3(-p.x, -p.y, -p.z));
    const sLeftBasePts = rightBranch.sPts.map(p => new THREE.Vector3(-p.x, -p.y, -p.z));
    const leftPts = applySubScale(leftBasePts, node.params.leftSub, stretch);
    const sLeftPts = applySubScale(sLeftBasePts, node.params.sLeftSub, stretch);

    if (node.params.showRight) {
        const rightLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(rightPts),
            new THREE.LineBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.9 })
        );
        rightLine.userData = { nodeId: node.id, part: 'right' };
        group.add(rightLine);
    }
    if (node.params.showS) {
        const sLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(sRightPts),
            new THREE.LineBasicMaterial({ color: 0xffe600, transparent: true, opacity: 0.8 })
        );
        sLine.userData = { nodeId: node.id, part: 's' };
        group.add(sLine);
    }
    if (node.params.showLeft) {
        const leftLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(leftPts),
            new THREE.LineBasicMaterial({ color: 0x00a0ff, transparent: true, opacity: 0.9 })
        );
        leftLine.userData = { nodeId: node.id, part: 'left' };
        group.add(leftLine);
    }
    if (node.params.showSLeft) {
        const sLeftLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(sLeftPts),
            new THREE.LineBasicMaterial({ color: 0xff8844, transparent: true, opacity: 0.8 })
        );
        sLeftLine.userData = { nodeId: node.id, part: 'sLeft' };
        group.add(sLeftLine);
    }

    const intensity = node.quantumState?.intensity || 0;
    const isExcited = intensity > 0.3;
    const sphereColor = isExcited ? 0x00ffcc : 0xffaa00;
    const sphereRadius = (4 + Math.min(intensity * 8, 14)) * nodeScale;
    const centerGeo = new THREE.SphereGeometry(sphereRadius, 16, 16);
    const centerMat = new THREE.MeshBasicMaterial({ color: sphereColor, transparent: true, opacity: isExcited ? 1.0 : 0.7 });
    const center = new THREE.Mesh(centerGeo, centerMat);
    center.userData = { nodeId: node.id, part: 'center' };
    group.add(center);

    const angles = node.params.angles || [0, 0, 0];
    group.rotation.x = THREE.MathUtils.degToRad(angles[0]);
    group.rotation.y = THREE.MathUtils.degToRad(angles[1]);
    group.rotation.z = THREE.MathUtils.degToRad(angles[2]);

    node.entryPoint = rightPts[0].clone();
    node.exitPoint = sRightPts[sRightPts.length - 1].clone();
    group.userData.nodeId = node.id;
    return group;
}

const meshMap = new Map();
let autoEdgeLines = [];

function updateNodeVisual(node) {
    if (meshMap.has(node.id)) {
        objectsGroup.remove(meshMap.get(node.id));
        meshMap.delete(node.id);
    }
    const group = createSfiralGroup(node);
    group.position.set(node.x, node.y, node.z);
    objectsGroup.add(group);
    meshMap.set(node.id, group);

    updateSelectionHighlights();
    drawAutoEdges();
}

function updateAllNodes() {
    meshMap.forEach((group) => objectsGroup.remove(group));
    meshMap.clear();
    graph.nodes.forEach(node => updateNodeVisual(node));
    updateEdges();
    updateStats();
    updateSelectionHighlights();
    drawAutoEdges();
}

function updateEdges() {
    const toRemove = [];
    objectsGroup.children.forEach(child => {
        if (child.isLine && (!child.userData?.nodeId || child.userData?.isChronoBridge)) toRemove.push(child);
    });
    toRemove.forEach(child => objectsGroup.remove(child));

    graph.edges.forEach(edge => {
        const fromNode = getNode(edge.from);
        const toNode = getNode(edge.to);
        if (!fromNode || !toNode) return;
        const fromGroup = meshMap.get(edge.from);
        const toGroup = meshMap.get(edge.to);
        if (!fromGroup || !toGroup) return;

        const exitWorld = new THREE.Vector3();
        const entryWorld = new THREE.Vector3();
        fromGroup.localToWorld(fromNode.exitPoint.clone(exitWorld));
        toGroup.localToWorld(toNode.entryPoint.clone(entryWorld));

        const pts = [exitWorld, entryWorld];
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const weightFactor = edge.weight !== undefined ? edge.weight : 0.5;
        const lineColor = new THREE.Color().setHSL(0.08, 1.0, 0.3 + weightFactor * 0.4);
        const mat = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.8 + weightFactor * 0.2 });
        const line = new THREE.Line(geo, mat);
        objectsGroup.add(line);
    });

    let chronoLinks = updateChronoQuantumLinks();
    chronoLinks.forEach(link => {
        let n1 = getNode(link.from);
        let n2 = getNode(link.to);
        if (!n1 || !n2) return;
        let pos1 = new THREE.Vector3(n1.x, n1.y, n1.z);
        let pos2 = new THREE.Vector3(n2.x, n2.y, n2.z);
        let geo = new THREE.BufferGeometry().setFromPoints([pos1, pos2]);
        let lineColor = link.chirality > 0 ? 0x00ffcc : 0xff8800;
        if (link.sharedState) lineColor = 0xffaa00;
        let mat = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.4 + link.weight * 0.5 });
        let line = new THREE.Line(geo, mat);
        line.userData = { isChronoBridge: true };
        objectsGroup.add(line);
    });

    drawAutoEdges();
    updateStats();
}

function drawAutoEdges() {
    if (autoEdgeLines.length > 0) {
        autoEdgeLines.forEach(line => objectsGroup.remove(line));
        autoEdgeLines = [];
    }

    const threshold = 150;
    const nodeIds = graph.nodes.map(n => n.id);
    for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
            const n1 = getNode(nodeIds[i]);
            const n2 = getNode(nodeIds[j]);
            if (!n1 || !n2) continue;
            const hasEdge = graph.edges.some(e => (e.from === n1.id && e.to === n2.id) || (e.from === n2.id && e.to === n1.id));
            if (hasEdge) continue;

            const g1 = meshMap.get(n1.id);
            const g2 = meshMap.get(n2.id);
            if (!g1 || !g2) continue;

            const exit1 = n1.exitPoint;
            const entry2 = n2.entryPoint;
            if (!exit1 || !entry2) continue;

            const exitWorld = new THREE.Vector3();
            const entryWorld = new THREE.Vector3();
            g1.localToWorld(exit1.clone(exitWorld));
            g2.localToWorld(entry2.clone(entryWorld));

            const dx = exitWorld.x - entryWorld.x;
            const dy = exitWorld.y - entryWorld.y;
            const dz = exitWorld.z - entryWorld.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist < threshold) {
                const pts = [exitWorld, entryWorld];
                const geo = new THREE.BufferGeometry().setFromPoints(pts);
                const mat = new THREE.LineDashedMaterial({ color: 0x00ff88, dashSize: 5, gapSize: 3, transparent: true, opacity: 0.3 });
                const line = new THREE.Line(geo, mat);
                line.computeLineDistances();
                objectsGroup.add(line);
                autoEdgeLines.push(line);
            }
        }
    }
}

function updateChronoQuantumLinks() {
    let activeChronoLinks = [];
    for (let i = 0; i < graph.nodes.length; i++) {
        for (let j = i + 1; j < graph.nodes.length; j++) {
            let n1 = graph.nodes[i];
            let n2 = graph.nodes[j];
            let bridge = walshEngine.evaluateChainBridge(n1, n2);
            if (bridge.isBridge) {
                let isSuperposition = (n1.quantumState?.intensity < 0.5 && n2.quantumState?.intensity < 0.5);
                activeChronoLinks.push({
                    from: n1.id, to: n2.id,
                    weight: bridge.weight, chirality: bridge.chirality,
                    sharedState: isSuperposition || bridge.sharedState
                });
            }
        }
    }
    return activeChronoLinks;
}

function updateStats() {
    document.getElementById('nodeCount').textContent = `Сфиралей: ${graph.nodes.length}`;
    
    let totalEdges = graph.edges.length;
    document.getElementById('edgeCount').textContent = `Хроноквантов: ${totalEdges}`;
    
    let totalParams = 0;
    graph.nodes.forEach(n => {
        totalParams += 12; 
        totalParams += 8;  
    });
    totalParams += totalEdges * 2;
    
    document.getElementById('paramCount').textContent = `Параметров: ${totalParams}`;
}

// ============================================================
// 6. ВЫДЕЛЕНИЕ И ТРАНСФОРМАЦИЯ
// ============================================================
function updateSelectionHighlights() {
    meshMap.forEach((group, id) => {
        const isSelectedNode = selectedNodes.includes(id);
        group.children.forEach(child => {
            if (child.isLine || child.isMesh) {
                const part = child.userData?.part;
                if (isSelectedNode) {
                    if (selectedPart && selectedPart !== part) child.material.opacity = 0.2;
                    else child.material.opacity = 1.0;
                } else {
                    child.material.opacity = 0.6;
                }
            }
        });
    });

    if (selectedNodes.length === 1) {
        const targetGroup = meshMap.get(selectedNodes[0]);
        if (targetGroup) {
            transformControls.attach(targetGroup);
            const node = getNode(selectedNodes[0]);
            if (node) updateBottomBarValues(node);
        }
    } else if (selectedNodes.length > 1) {
        let cx = 0, cy = 0, cz = 0;
        const targetNodes = selectedNodes.map(nid => getNode(nid)).filter(Boolean);
        targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
        cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

        groupTransformProxy.position.set(cx, cy, cz);
        groupTransformProxy.rotation.set(0, 0, 0);
        transformControls.attach(groupTransformProxy);
        lastProxyPosition.copy(groupTransformProxy.position);
        lastProxyRotation.copy(groupTransformProxy.rotation);
        updateBottomBarValues(null);
    } else {
        transformControls.detach();
        updateBottomBarValues(null);
    }
}

function getObjectUnderMouse(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    const mouse = new THREE.Vector2();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const targets = [];
    meshMap.forEach(group => {
        group.children.forEach(child => {
            if (child.userData && child.userData.part) targets.push(child);
        });
    });
    const intersects = raycaster.intersectObjects(targets, true);
    if (intersects.length > 0) {
        let hit = intersects[0].object;
        if (hit && hit.userData?.nodeId) return { nodeId: hit.userData.nodeId, part: hit.userData.part };
    }
    return null;
}

// ============================================================
// 7. UI-МЕНЕДЖЕР
// ============================================================
class UIManager {
    constructor() {
        this.createBottomBar();
        this.createToolbarButtons();
        this.createMoveDialog();
        this.createRotateDialog();
        this.createStatusBar();
        this.createLoadingIndicator();
        this.setupEventListeners();
        this.setupKeyboardShortcuts();
    }

    createBottomBar() {
        if (document.getElementById('bottomCoordBar')) return;
        const bar = document.createElement('div');
        bar.id = 'bottomCoordBar';
        bar.className = 'bottom-bar';
        bar.innerHTML = `
            <div class="coord-group">
                <span class="label">XYZ:</span>
                <div class="coord-input"><span style="color:#ff4444;">X</span><input type="number" id="botPosX" value="0" step="1" /></div>
                <div class="coord-input"><span style="color:#00ffaa;">Y</span><input type="number" id="botPosY" value="0" step="1" /></div>
                <div class="coord-input"><span style="color:#00a0ff;">Z</span><input type="number" id="botPosZ" value="0" step="1" /></div>
            </div>
            <div class="divider"></div>
            <div class="coord-group">
                <span class="label">ROT (°):</span>
                <div class="coord-input"><span style="color:#ff4444;">X</span><input type="number" id="botRotX" value="0" step="5" /></div>
                <div class="coord-input"><span style="color:#00ffaa;">Y</span><input type="number" id="botRotY" value="0" step="5" /></div>
                <div class="coord-input"><span style="color:#00a0ff;">Z</span><input type="number" id="botRotZ" value="0" step="5" /></div>
            </div>
        `;
        container.style.bottom = '26px';
        container.appendChild(bar);
    }

    createToolbarButtons() {
        const viewTools = document.getElementById('view-tools');
        if (!viewTools) return;

        const sep = document.createElement('div');
        sep.className = 'toolbar-separator';
        viewTools.appendChild(sep);

        const transBtn = this.createButton('⤩ Перенос', 'Режим перемещения\nПравый клик — точный ввод координат', 'tool-btn', true);
        transBtn.id = 'toolTranslateBtn';
        transBtn.addEventListener('click', () => {
            transformControls.setMode('translate');
            this.setActiveTool('translate');
        });
        transBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (selectedNodes.length === 0) { alert('Выберите сфираль или группу'); return; }
            openMoveDialog();
        });
        viewTools.appendChild(transBtn);

        const rotBtn = this.createButton('🔄 Поворот', 'Режим поворота\nПравый клик — точный ввод углов', 'tool-btn');
        rotBtn.id = 'toolRotateBtn';
        rotBtn.addEventListener('click', () => {
            transformControls.setMode('rotate');
            this.setActiveTool('rotate');
        });
        rotBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (selectedNodes.length === 0) { alert('Выберите сфираль или группу'); return; }
            openRotateDialog();
        });
        viewTools.appendChild(rotBtn);

        const axisLegend = document.createElement('div');
        axisLegend.className = 'axis-legend';
        axisLegend.innerHTML = `
            <span style="color:#ff4444;">X</span>
            <span style="color:#00ffaa;">Y</span>
            <span style="color:#00a0ff;">Z</span>
        `;
        viewTools.appendChild(axisLegend);

        const resetViewBtn = this.createButton('⌖ Сброс', 'Сбросить вид', 'tool-btn');
        resetViewBtn.addEventListener('click', () => switchView('perspective'));
        viewTools.appendChild(resetViewBtn);

        const centerBtn = this.createButton('⊙ Центр', 'Центрировать по выделенному', 'tool-btn');
        centerBtn.addEventListener('click', () => {
            if (selectedNodes.length > 0) {
                let cx = 0, cy = 0, cz = 0;
                const targetNodes = selectedNodes.map(nid => getNode(nid)).filter(Boolean);
                targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
                cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;
                controls.target.set(cx, cy, cz);
                controls.update();
            }
        });
        viewTools.appendChild(centerBtn);
    }

    createButton(text, title, className, active = false) {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.title = title;
        btn.className = className;
        if (active) btn.classList.add('active');
        return btn;
    }

    setActiveTool(mode) {
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        if (mode === 'translate') {
            document.getElementById('toolTranslateBtn').classList.add('active');
        } else if (mode === 'rotate') {
            document.getElementById('toolRotateBtn').classList.add('active');
        }
    }

    createMoveDialog() {
        if (document.getElementById('moveDialogModal')) return;
        const modal = document.createElement('div');
        modal.id = 'moveDialogModal';
        modal.className = 'modal';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div style="font-weight:bold; color:#00e5ff; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1f2d4a; padding-bottom:4px;">
                <span>⤩ Перемещение</span>
                <span id="closeMoveModalX" style="cursor:pointer; color:#88a0c0; font-size:0.9rem;">✕</span>
            </div>
            <div style="display:flex; flex-direction:column; gap:6px;">
                <div style="display:flex; align-items:center; justify-content:space-between;"><span style="color:#ff4444;">X:</span><input type="number" id="modalPosX" value="0" step="1" style="background:#1c2841; border:1px solid #2a3f6d; color:#fff; width:110px; padding:2px 4px; border-radius:3px; text-align:center;" /></div>
                <div style="display:flex; align-items:center; justify-content:space-between;"><span style="color:#00ffaa;">Y:</span><input type="number" id="modalPosY" value="0" step="1" style="background:#1c2841; border:1px solid #2a3f6d; color:#fff; width:110px; padding:2px 4px; border-radius:3px; text-align:center;" /></div>
                <div style="display:flex; align-items:center; justify-content:space-between;"><span style="color:#00a0ff;">Z:</span><input type="number" id="modalPosZ" value="0" step="1" style="background:#1c2841; border:1px solid #2a3f6d; color:#fff; width:110px; padding:2px 4px; border-radius:3px; text-align:center;" /></div>
            </div>
        `;
        document.body.appendChild(modal);
        this.makeDraggable('moveDialogModal');
    }

    createRotateDialog() {
        if (document.getElementById('rotateDialogModal')) return;
        const modal = document.createElement('div');
        modal.id = 'rotateDialogModal';
        modal.className = 'modal';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div style="font-weight:bold; color:#00e5ff; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1f2d4a; padding-bottom:4px;">
                <span>🔄 Поворот группы (°)</span>
                <span id="closeRotModalX" style="cursor:pointer; color:#88a0c0; font-size:0.9rem;">✕</span>
            </div>
            <div style="display:flex; flex-direction:column; gap:6px;">
                <div style="display:flex; align-items:center; justify-content:space-between;"><span style="color:#ff4444;">X:</span><input type="number" id="modalRotX" value="0" step="5" style="background:#1c2841; border:1px solid #2a3f6d; color:#fff; width:110px; padding:2px 4px; border-radius:3px; text-align:center;" /></div>
                <div style="display:flex; align-items:center; justify-content:space-between;"><span style="color:#00ffaa;">Y:</span><input type="number" id="modalRotY" value="0" step="5" style="background:#1c2841; border:1px solid #2a3f6d; color:#fff; width:110px; padding:2px 4px; border-radius:3px; text-align:center;" /></div>
                <div style="display:flex; align-items:center; justify-content:space-between;"><span style="color:#00a0ff;">Z:</span><input type="number" id="modalRotZ" value="0" step="5" style="background:#1c2841; border:1px solid #2a3f6d; color:#fff; width:110px; padding:2px 4px; border-radius:3px; text-align:center;" /></div>
            </div>
        `;
        document.body.appendChild(modal);
        this.makeDraggable('rotateDialogModal');
    }

    createStatusBar() {
        if (document.getElementById('statusBar')) return;
        const status = document.createElement('div');
        status.id = 'statusBar';
        status.className = 'status-bar';
        status.innerHTML = `
            <span id="statusMode">Режим: просмотр</span>
            <span id="statusObjects">Выделено: 0</span>
            <span id="statusCoords">Центр: 0, 0, 0</span>
        `;
        document.body.appendChild(status);
    }

    createLoadingIndicator() {
        if (document.getElementById('loadingIndicator')) return;
        const loader = document.createElement('div');
        loader.id = 'loadingIndicator';
        loader.className = 'loading-indicator hidden';
        loader.innerHTML = '<div class="spinner"></div><span>Обработка...</span>';
        document.body.appendChild(loader);
    }

    makeDraggable(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        let isDragging = false, startX, startY;

        modal.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.id === 'closeMoveModalX' || e.target.id === 'closeRotModalX') return;
            isDragging = true;
            startX = e.clientX - modal.offsetLeft;
            startY = e.clientY - modal.offsetTop;
            modal.style.transform = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            let newX = e.clientX - startX;
            let newY = e.clientY - startY;
            const maxX = window.innerWidth - modal.offsetWidth;
            const maxY = window.innerHeight - modal.offsetHeight;
            newX = Math.max(0, Math.min(newX, maxX));
            newY = Math.max(0, Math.min(newY, maxY));
            modal.style.left = newX + 'px';
            modal.style.top = newY + 'px';
        });

        document.addEventListener('mouseup', () => { isDragging = false; });
    }

    setupEventListeners() {
        document.getElementById('closeMoveModalX')?.addEventListener('click', () => {
            document.getElementById('moveDialogModal').style.display = 'none';
        });
        document.getElementById('closeRotModalX')?.addEventListener('click', () => {
            document.getElementById('rotateDialogModal').style.display = 'none';
        });

        ['modalPosX', 'modalPosY', 'modalPosZ'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', applyModalPositionLive);
                el.addEventListener('change', () => { saveState(); sendDataToPythonCore(); });
            }
        });

        ['modalRotX', 'modalRotY', 'modalRotZ'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', applyModalRotationLive);
                el.addEventListener('change', () => { saveState(); sendDataToPythonCore(); });
            }
        });

        ['botPosX', 'botPosY', 'botPosZ'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', applyBottomBarPositionLive);
                el.addEventListener('change', () => { saveState(); sendDataToPythonCore(); });
            }
        });
        ['botRotX', 'botRotY', 'botRotZ'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', applyBottomBarRotationLive);
                el.addEventListener('change', () => { saveState(); sendDataToPythonCore(); });
            }
        });

        document.getElementById('addNodeBtn')?.addEventListener('click', addNodeHandler);
        document.getElementById('deleteBtn')?.addEventListener('click', deleteSelected);
        document.getElementById('connectBtn')?.addEventListener('click', connectSelected);
        document.getElementById('copyGroupBtn')?.addEventListener('click', copySelected);
        document.getElementById('simulateBtn')?.addEventListener('click', simulateResonance);
        document.getElementById('toggleWalshBtn')?.addEventListener('click', computeWalsh);
        document.getElementById('saveModelBtn')?.addEventListener('click', saveModel);
        document.getElementById('loadModelBtn')?.addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('fileInput')?.addEventListener('change', loadModel);
        document.getElementById('fractalPresetBtn')?.addEventListener('click', buildFractalComposition);
        document.getElementById('applyGlobalFractalBtn')?.addEventListener('click', buildFractalComposition);

        document.querySelectorAll('#view-tools button[data-view]').forEach(btn => {
            btn.addEventListener('click', () => switchView(btn.dataset.view));
        });

        this.setupMouseSelection();
    }

    setupMouseSelection() {
        const selectionRect = document.getElementById('selectionRect');
        let mouseDownPos = { x: 0, y: 0 };
        let mouseDownObjectId = null;
        let mouseDownPart = null;
        let isDragging = false;
        let isBoxSelecting = false;
        let boxStart = { x: 0, y: 0 };

        renderer.domElement.addEventListener('pointerdown', (e) => {
            if (e.button === 2 && e.ctrlKey) {
                controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
                controls.enabled = true;
                return;
            } else if (e.button === 2) {
                controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
            }
            if (e.button !== 0) return;

            document.getElementById('moveDialogModal').style.display = 'none';
            document.getElementById('rotateDialogModal').style.display = 'none';

            mouseDownPos.x = e.clientX;
            mouseDownPos.y = e.clientY;
            const hitData = getObjectUnderMouse(e.clientX, e.clientY);
            mouseDownObjectId = hitData ? hitData.nodeId : null;
            mouseDownPart = hitData ? hitData.part : null;
            isDragging = false;
            isBoxSelecting = false;

            if (mouseDownObjectId === null && !transformControls.dragging) {
                isBoxSelecting = true;
                boxStart.x = e.clientX;
                boxStart.y = e.clientY;
                selectionRect.style.display = 'block';
                selectionRect.style.left = boxStart.x + 'px';
                selectionRect.style.top = boxStart.y + 'px';
                selectionRect.style.width = '0px';
                selectionRect.style.height = '0px';
                controls.enabled = false;
            }
        });

        renderer.domElement.addEventListener('pointermove', (e) => {
            const dx = e.clientX - mouseDownPos.x;
            const dy = e.clientY - mouseDownPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (!isDragging && (e.buttons & 1) && dist > 5) isDragging = true;

            if (isBoxSelecting) {
                const rect = container.getBoundingClientRect();
                const x1 = boxStart.x - rect.left, y1 = boxStart.y - rect.top;
                const x2 = e.clientX - rect.left, y2 = e.clientY - rect.top;
                selectionRect.style.left = Math.min(x1, x2) + 'px';
                selectionRect.style.top = Math.min(y1, y2) + 'px';
                selectionRect.style.width = Math.abs(x2 - x1) + 'px';
                selectionRect.style.height = Math.abs(y2 - y1) + 'px';
            }
        });

        renderer.domElement.addEventListener('pointerup', (e) => {
            if (e.button === 2) { controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE; return; }
            if (e.button !== 0) return;
            const dx = e.clientX - mouseDownPos.x;
            const dy = e.clientY - mouseDownPos.y;
            const isClick = Math.sqrt(dx * dx + dy * dy) < 5;

            if (isBoxSelecting) {
                isBoxSelecting = false;
                selectionRect.style.display = 'none';
                const rect = container.getBoundingClientRect();
                const x1 = boxStart.x - rect.left, y1 = boxStart.y - rect.top;
                const x2 = e.clientX - rect.left, y2 = e.clientY - rect.top;
                const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
                const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
                const newSelection = [];
                meshMap.forEach((group, id) => {
                    const pos = new THREE.Vector3();
                    group.getWorldPosition(pos);
                    pos.project(camera);
                    const ndcX = (pos.x + 1) / 2 * rect.width;
                    const ndcY = (1 - (pos.y + 1) / 2) * rect.height;
                    if (ndcX >= minX && ndcX <= maxX && ndcY >= minY && ndcY <= maxY) newSelection.push(id);
                });

                if (e.ctrlKey || e.shiftKey) selectedNodes = [...new Set([...selectedNodes, ...newSelection])];
                else selectedNodes = newSelection;

                selectedPart = null;
                updateSelectionHighlights();
                renderProperties(selectedNodes.length === 1 ? selectedNodes[0] : null);
                controls.enabled = true;
                return;
            }

            if (isClick) {
                if (mouseDownObjectId !== null) {
                    const id = mouseDownObjectId;
                    if (e.ctrlKey || e.shiftKey) {
                        selectedNodes = selectedNodes.includes(id) ? selectedNodes.filter(nid => nid !== id) : [...selectedNodes, id];
                        selectedPart = null;
                    } else {
                        selectedNodes = [id];
                        selectedPart = mouseDownPart;
                    }
                    updateSelectionHighlights();
                    const targetNode = getNode(id);
                    if (targetNode) { controls.target.set(targetNode.x, targetNode.y, targetNode.z); controls.update(); }
                    renderProperties(selectedNodes.length === 1 ? selectedNodes[0] : null);
                } else {
                    if (!transformControls.dragging && !e.ctrlKey && !e.shiftKey) {
                        selectedNodes = [];
                        selectedPart = null;
                        transformControls.detach();
                        updateSelectionHighlights();
                        renderProperties(null);
                    }
                }
            }
            isDragging = false;
            mouseDownObjectId = null;
            mouseDownPart = null;
            controls.enabled = true;
        });

        renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    setupKeyboardShortcuts() {
        window.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                if (e.key === 'Escape') e.target.blur();
                return;
            }
            const key = e.key.toLowerCase();

            if (e.ctrlKey && key === 'z') {
                e.preventDefault();
                if (e.shiftKey) redo();
                else undo();
            } else if (e.ctrlKey && (key === 'y' || (e.shiftKey && key === 'z'))) {
                e.preventDefault();
                redo();
            } else if (e.ctrlKey && key === 'c') {
                e.preventDefault();
                copySelected();
            } else if (e.ctrlKey && key === 'v') {
                e.preventDefault();
                pasteClipboard();
            } else if (e.ctrlKey && key === 'a') {
                e.preventDefault();
                selectedNodes = graph.nodes.map(n => n.id);
                selectedPart = null;
                updateSelectionHighlights();
                renderProperties(selectedNodes.length === 1 ? selectedNodes[0] : null);
            } else if (e.key === 'Delete' || e.key === 'Del') {
                e.preventDefault();
                deleteSelected();
            } else if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key >= '1' && e.key <= '4') {
                const views = ['perspective', 'top', 'front', 'side'];
                const idx = parseInt(e.key) - 1;
                if (idx < views.length) {
                    e.preventDefault();
                    switchView(views[idx]);
                }
            } else if (e.key === 'Escape') {
                if (!e.ctrlKey && !e.altKey) {
                    selectedNodes = [];
                    selectedPart = null;
                    transformControls.detach();
                    updateSelectionHighlights();
                    renderProperties(null);
                    document.getElementById('moveDialogModal').style.display = 'none';
                    document.getElementById('rotateDialogModal').style.display = 'none';
                }
            }
        }, true);
    }
}

// ============================================================
// 8. ОБРАБОТЧИКИ ДЕЙСТВИЙ (LIVE И ГРУППОВЫЕ РАСЧЕТЫ)
// ============================================================
function updateBottomBarValues(node) {
    if (!node) {
        document.getElementById('botPosX').value = 0;
        document.getElementById('botPosY').value = 0;
        document.getElementById('botPosZ').value = 0;
        document.getElementById('botRotX').value = 0;
        document.getElementById('botRotY').value = 0;
        document.getElementById('botRotZ').value = 0;
        return;
    }
    document.getElementById('botPosX').value = Math.round(node.x);
    document.getElementById('botPosY').value = Math.round(node.y);
    document.getElementById('botPosZ').value = Math.round(node.z);
    document.getElementById('botRotX').value = node.params.angles[0];
    document.getElementById('botRotY').value = node.params.angles[1];
    document.getElementById('botRotZ').value = node.params.angles[2];
}

function applyModalPositionLive() {
    if (selectedNodes.length === 0) return;
    const px = parseFloat(document.getElementById('modalPosX').value);
    const py = parseFloat(document.getElementById('modalPosY').value);
    const pz = parseFloat(document.getElementById('modalPosZ').value);
    if (isNaN(px) && isNaN(py) && isNaN(pz)) return;

    if (selectedNodes.length === 1) {
        const node = getNode(selectedNodes[0]);
        if (!node) return;
        let changed = false;
        if (!isNaN(px) && node.x !== px) { node.x = px; changed = true; }
        if (!isNaN(py) && node.y !== py) { node.y = py; changed = true; }
        if (!isNaN(pz) && node.z !== pz) { node.z = pz; changed = true; }
        if (changed) {
            updateNodeVisual(node);
            updateBottomBarValues(node);
            updateEdges();
            updateStats();
            sendDataPythonCoreThrottled();
        }
    } else {
        let cx = 0, cy = 0, cz = 0;
        const targetNodes = selectedNodes.map(nid => getNode(nid)).filter(Boolean);
        targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
        cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

        const targetX = !isNaN(px) ? px : cx;
        const targetY = !isNaN(py) ? py : cy;
        const targetZ = !isNaN(pz) ? pz : cz;

        const dx = targetX - cx;
        const dy = targetY - cy;
        const dz = targetZ - cz;

        if (dx !== 0 || dy !== 0 || dz !== 0) {
            targetNodes.forEach(node => {
                node.x += dx;
                node.y += dy;
                node.z += dz;
                updateNodeVisual(node);
            });
            updateEdges();
            updateStats();
            sendDataPythonCoreThrottled();
        }
    }
}

function applyModalRotationLive() {
    if (selectedNodes.length === 0) return;
    const rx = parseFloat(document.getElementById('modalRotX').value);
    const ry = parseFloat(document.getElementById('modalRotY').value);
    const rz = parseFloat(document.getElementById('modalRotZ').value);
    if (isNaN(rx) && isNaN(ry) && isNaN(rz)) return;

    if (selectedNodes.length === 1) {
        const node = getNode(selectedNodes[0]);
        if (!node) return;
        let changed = false;
        if (!isNaN(rx) && node.params.angles[0] !== rx) { node.params.angles[0] = rx; changed = true; }
        if (!isNaN(ry) && node.params.angles[1] !== ry) { node.params.angles[1] = ry; changed = true; }
        if (!isNaN(rz) && node.params.angles[2] !== rz) { node.params.angles[2] = rz; changed = true; }
        if (changed) {
            updateNodeVisual(node);
            updateBottomBarValues(node);
            updateEdges();
            updateStats();
            sendDataPythonCoreThrottled();
        }
    } else {
        let cx = 0, cy = 0, cz = 0;
        const targetNodes = selectedNodes.map(nid => getNode(nid)).filter(Boolean);
        targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
        cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

        const firstNode = targetNodes[0];
        const curRot = firstNode.params.angles || [0, 0, 0];
        
        const targetRx = !isNaN(rx) ? rx : curRot[0];
        const targetRy = !isNaN(ry) ? ry : curRot[1];
        const targetZ = !isNaN(rz) ? rz : curRot[2];

        const deltaX = THREE.MathUtils.degToRad(targetRx - curRot[0]);
        const deltaY = THREE.MathUtils.degToRad(targetRy - curRot[1]);
        const deltaZ = THREE.MathUtils.degToRad(targetZ - curRot[2]);

        const eulerDelta = new THREE.Euler(deltaX, deltaY, deltaZ, 'XYZ');
        const quatDelta = new THREE.Quaternion().setFromEuler(eulerDelta);

        targetNodes.forEach(node => {
            const group = meshMap.get(node.id);
            if (!group) return;

            const v = new THREE.Vector3(node.x, node.y, node.z).sub(new THREE.Vector3(cx, cy, cz));
            v.applyQuaternion(quatDelta);
            v.add(new THREE.Vector3(cx, cy, cz));
            node.x = v.x; node.y = v.y; node.z = v.z;

            group.rotation.setFromQuaternion(group.quaternion.premultiply(quatDelta));
            node.params.angles = [
                THREE.MathUtils.radToDeg(group.rotation.x),
                THREE.MathUtils.radToDeg(group.rotation.y),
                THREE.MathUtils.radToDeg(group.rotation.z)
            ];
            updateNodeVisual(node);
        });
        updateEdges();
        updateStats();
        sendDataPythonCoreThrottled();
    }
}

function applyBottomBarPositionLive() {
    applyModalPositionLive();
}

function applyBottomBarRotationLive() {
    applyModalRotationLive();
}

function openMoveDialog() {
    document.getElementById('rotateDialogModal').style.display = 'none';
    if (selectedNodes.length > 0) {
        let cx = 0, cy = 0, cz = 0;
        const targetNodes = selectedNodes.map(nid => getNode(nid)).filter(Boolean);
        targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
        cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

        document.getElementById('modalPosX').value = Math.round(cx);
        document.getElementById('modalPosY').value = Math.round(cy);
        document.getElementById('modalPosZ').value = Math.round(cz);
    }
    document.getElementById('moveDialogModal').style.display = 'block';
}

function openRotateDialog() {
    document.getElementById('moveDialogModal').style.display = 'none';
    if (selectedNodes.length > 0) {
        const node = getNode(selectedNodes[0]);
        if (node) {
            document.getElementById('modalRotX').value = node.params.angles[0];
            document.getElementById('modalRotY').value = node.params.angles[1];
            document.getElementById('modalRotZ').value = node.params.angles[2];
        }
    }
    document.getElementById('rotateDialogModal').style.display = 'block';
}

function switchView(view) {
    document.querySelectorAll('#view-tools button[data-view]').forEach(b => b.classList.remove('view-active'));
    document.querySelector(`#view-tools button[data-view="${view}"]`)?.classList.add('view-active');
    let pos, target = new THREE.Vector3(0, 0, 0);
    const dist = 600;
    switch(view) {
        case 'perspective': pos = new THREE.Vector3(600, 400, 800); break;
        case 'top': pos = new THREE.Vector3(0, dist*1.2, 0); break;
        case 'front': pos = new THREE.Vector3(0, 0, dist*1.2); break;
        case 'side': pos = new THREE.Vector3(dist*1.2, 0, 0); break;
    }
    camera.position.copy(pos);
    controls.target.copy(target);
    controls.update();
}

// ============================================================
// 9. ИСТОРИЯ (UNDO/REDO) И БУФЕР ОБМЕНА
// ============================================================
function saveState() {
    const state = {
        nodes: graph.nodes.map(n => ({
            ...n,
            params: {
                ...n.params,
                angles: [...n.params.angles],
                rightSub: { ...n.params.rightSub },
                leftSub: { ...n.params.leftSub },
                sRightSub: { ...n.params.sRightSub },
                sLeftSub: { ...n.params.sLeftSub }
            }
        })),
        edges: graph.edges.map(e => ({ ...e }))
    };
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
}

function loadState(state) {
    graph.nodes = state.nodes.map(n => ({ ...n, params: { ...n.params, angles: [...n.params.angles] } }));
    graph.edges = state.edges.map(e => ({ ...e }));
    let maxId = 0;
    graph.nodes.forEach(n => { if (n.id > maxId) maxId = n.id; });
    nextId = maxId + 1;
    updateAllNodes();
    updateSelectionHighlights();
    updateStats();
    renderProperties(selectedNodes.length === 1 ? selectedNodes[0] : null);
}

function undo() {
    if (undoStack.length === 0) return;
    const currentState = JSON.stringify({
        nodes: graph.nodes.map(n => ({ ...n, params: { ...n.params, angles: [...n.params.angles] } })),
        edges: graph.edges.map(e => ({ ...e }))
    });
    redoStack.push(currentState);
    const prevState = JSON.parse(undoStack.pop());
    loadState(prevState);
    sendDataToPythonCore();
}

function redo() {
    if (redoStack.length === 0) return;
    const currentState = JSON.stringify({
        nodes: graph.nodes.map(n => ({ ...n, params: { ...n.params, angles: [...n.params.angles] } })),
        edges: graph.edges.map(e => ({ ...e }))
    });
    undoStack.push(currentState);
    const nextState = JSON.parse(redoStack.pop());
    loadState(nextState);
    sendDataToPythonCore();
}

function copySelected() {
    if (selectedNodes.length === 0) {
        alert('Выберите хотя бы одну сфираль для копирования');
        return;
    }
    const copiedNodes = selectedNodes.map(id => {
        const src = getNode(id);
        return src ? JSON.parse(JSON.stringify(src)) : null;
    }).filter(Boolean);

    const copiedEdges = graph.edges
        .filter(e => selectedNodes.includes(e.from) && selectedNodes.includes(e.to))
        .map(e => ({ ...e }));

    clipboard = { nodes: copiedNodes, edges: copiedEdges };
    pasteClipboard();
}

function pasteClipboard() {
    if (!clipboard || clipboard.nodes.length === 0) {
        alert('Буфер обмена пуст.');
        return;
    }
    saveState();
    const idMap = {};
    const newIds = [];

    clipboard.nodes.forEach(src => {
        const newNode = addNode(src.mode, src.x, src.y, src.z, {
            N: src.params.N,
            target_len: src.params.target_len,
            scale: src.params.scale,
            stretch: src.params.stretch,
            angles: [...src.params.angles],
            showRight: src.params.showRight,
            showS: src.params.showS,
            showLeft: src.params.showLeft,
            showSLeft: src.params.showSLeft,
            rightSub: { ...src.params.rightSub },
            leftSub: { ...src.params.leftSub },
            sRightSub: { ...src.params.sRightSub },
            sLeftSub: { ...src.params.sLeftSub }
        });
        idMap[src.id] = newNode.id;
        newIds.push(newNode.id);
        updateNodeVisual(newNode);
    });

    clipboard.edges.forEach(edge => {
        const newFrom = idMap[edge.from];
        const newTo = idMap[edge.to];
        if (newFrom !== undefined && newTo !== undefined) {
            addEdge(newFrom, newTo, edge.weight);
        }
    });

    updateEdges();
    updateStats();
    selectedNodes = newIds;
    selectedPart = null;
    updateSelectionHighlights();
    renderProperties(selectedNodes.length === 1 ? selectedNodes[0] : null);
    sendDataToPythonCore();
}

// ============================================================
// 10. ДЕЙСТВИЯ: ДОБАВЛЕНИЕ, УДАЛЕНИЕ, СОЕДИНЕНИЕ, ПРЕСЕТЫ
// ============================================================
function addNodeHandler() {
    saveState();
    const count = graph.nodes.length;
    const node = addNode('Single', (count % 5 - 2) * 80, Math.floor(count / 5) * 80, 0, { N: 5, target_len: 1000, scale: 1.0, stretch: 1.0, angles: [0, 0, 0] }); // 👈 НУЛЕВЫЕ УГЛЫ
    updateNodeVisual(node);
    updateEdges();
    updateStats();
    selectedNodes = [node.id];
    selectedPart = null;
    updateSelectionHighlights();
    renderProperties(node.id);
    sendDataToPythonCore();
}

function deleteSelected() {
    if (selectedNodes.length === 0) return alert('Выберите сфирали');
    saveState();

    if (selectedPart && selectedNodes.length === 1) {
        const node = getNode(selectedNodes[0]);
        if (node) {
            if (selectedPart === 'right') node.params.showRight = false;
            if (selectedPart === 's') node.params.showS = false;
            if (selectedPart === 'left') node.params.showLeft = false;
            if (selectedPart === 'sLeft') node.params.showSLeft = false;
            updateNodeVisual(node);
            selectedPart = null;
            renderProperties(node.id);
            sendDataToPythonCore();
            return;
        }
    }

    selectedNodes.forEach(id => {
        removeNode(id);
        if (meshMap.has(id)) { objectsGroup.remove(meshMap.get(id)); meshMap.delete(id); }
    });
    selectedNodes = [];
    selectedPart = null;
    transformControls.detach();
    updateEdges();
    updateStats();
    renderProperties(null);
    updateSelectionHighlights();
    sendDataToPythonCore();
}

function connectSelected() {
    if (selectedNodes.length === 2) {
        saveState();
        const edge = addEdge(selectedNodes[0], selectedNodes[1]);
        if (edge) { updateEdges(); updateStats(); sendDataToPythonCore(); }
        else alert('Связь уже существует');
    } else {
        alert('Выделите ровно две сфирали');
    }
}

function buildSingleInitialSfiral() {
    saveState();
    graph.nodes = []; graph.edges = []; nextId = 1;
    const node = addNode('Single', 0, 0, 0, { N: 5, target_len: 1000, scale: 1.0, stretch: 1.0, angles: [0, 0, 0] }); // 👈 НУЛЕВЫЕ УГЛЫ
    updateAllNodes();
    selectedNodes = [node.id];
    selectedPart = null;
    updateSelectionHighlights();
    renderProperties(node.id);
    sendDataToPythonCore();
}

function buildFractalComposition() {
    saveState();
    graph.nodes = []; graph.edges = []; nextId = 1;
    const n1 = addNode('Single', 0, 0, 0, { N: 5, target_len: 1000, scale: 1.0, stretch: 1.0, angles: [0, 0, 0] });
    const n2 = addNode('Single', 0, 35, 45, { N: 5, target_len: 500, scale: 0.5, stretch: 1.0, angles: [0, 0, 0] });
    const n3 = addNode('Single', 0, -35, -45, { N: 5, target_len: 500, scale: 0.5, stretch: 1.0, angles: [0, 0, 0] });
    const n4 = addNode('Single', 0, -35, -45, { N: 5, target_len: 500, scale: 0.5, stretch: 1.0, angles: [0, 0, 0] });
    const n5 = addNode('Single', 0, 35, 45, { N: 5, target_len: 500, scale: 0.5, stretch: 1.0, angles: [0, 0, 0] });
    const n6 = addNode('Single', 0, 0, 0, { N: 5, target_len: 1000, scale: 1.0, stretch: 1.0, angles: [0, 0, 0] });
    addEdge(n1.id, n6.id, 1.0);
    addEdge(n1.id, n2.id, 0.8);
    addEdge(n1.id, n5.id, 0.8);
    addEdge(n6.id, n3.id, 0.8);
    addEdge(n6.id, n4.id, 0.8);
    updateAllNodes();
    selectedNodes = [n1.id];
    selectedPart = null;
    updateSelectionHighlights();
    renderProperties(n1.id);
    sendDataToPythonCore();
}

function simulateResonance() {
    if (graph.nodes.length === 0) { alert('Нет сфиралей'); return; }
    const consoleEl = document.getElementById('console');
    consoleEl.style.display = 'block';
    consoleEl.innerHTML = '<div class="line">⚙️ Выполнение резонансного анализа...</div>';
    let psi = {};
    graph.nodes.forEach(n => { psi[n.id] = { real: Math.random(), imag: Math.random() }; });
    for (let iter = 0; iter < 30; iter++) {
        let nextPsi = {};
        graph.nodes.forEach(n => { nextPsi[n.id] = { real: 0.0, imag: 0.0 }; });
        const firstNode = graph.nodes[0];
        if (nextPsi[firstNode.id]) nextPsi[firstNode.id].real += 1.5;
        graph.edges.forEach(edge => {
            const u = edge.from, v = edge.to;
            const source = psi[u] || { real: 0, imag: 0 };
            const w = edge.weight !== undefined ? edge.weight : 0.5;
            const chiralityFactor = (v % 2 !== 0) ? 0.2 : -0.2;
            const trReal = w * (source.real * Math.cos(chiralityFactor) - source.imag * Math.sin(chiralityFactor));
            const trImag = w * (source.real * Math.sin(chiralityFactor) + source.imag * Math.cos(chiralityFactor));
            if (!nextPsi[v]) nextPsi[v] = { real: 0, imag: 0 };
            nextPsi[v].real += trReal; nextPsi[v].imag += trImag;
        });
        psi = nextPsi;
    }
    let totalEnergy = 0;
    graph.nodes.forEach(n => {
        const p = psi[n.id] || { real: 0, imag: 0 };
        const intensity = (p.real * p.real) + (p.imag * p.imag);
        n.quantumState = { intensity, psi_real: p.real, psi_imag: p.imag };
        totalEnergy += intensity;
        updateNodeVisual(n);
    });
    updateEdges();
    sendDataToPythonCore();
    consoleEl.innerHTML = `<div class="line success">✅ Резонанс просчитан! Энергия: ${totalEnergy.toFixed(4)}</div>`;
}

function computeWalsh() {
    if (graph.nodes.length === 0) { alert('Нет сфиралей'); return; }
    const consoleEl = document.getElementById('console');
    consoleEl.style.display = 'block';
    consoleEl.innerHTML = '<div class="line">🌀 Вычисление троичного пространственного спектра Уолша...</div>';

    let time = performance.now() * 0.002;
    let positiveCount = 0, negativeCount = 0, zeroCount = 0;

    graph.nodes.forEach(n => {
        walshEngine.evaluateNode(n, time);
        updateNodeVisual(n);
        const intensity = n.quantumState?.intensity || 0;
        if (intensity > 0.3) positiveCount++;
        else if (intensity < 0.1) zeroCount++;
        else negativeCount++;
    });

    consoleEl.innerHTML = `
        <div class="line success">✅ Расчет по Уолшу завершен!</div>
        <div class="line">📊 Активных (+1): ${positiveCount} | Нейтральных (0): ${zeroCount} | Инверсных (-1): ${negativeCount}</div>
    `;
}

function saveModel() {
    if (graph.nodes.length === 0) return alert('Нет сфиралей');
    const data = JSON.stringify({ model_name: "GIDEON-Fractal-Complex", total_nodes: graph.nodes.length, nodes: graph.nodes, edges: graph.edges }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'fractal_model_export.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

function loadModel(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            if (!data.nodes) throw new Error('Неверный формат JSON');
            graph.nodes = []; graph.edges = [];
            let maxId = 0;
            data.nodes.forEach(n => { if (n.id > maxId) maxId = n.id; });
            nextId = maxId + 1;
            data.nodes.forEach(n => {
                graph.nodes.push({
                    id: n.id, mode: n.mode || 'Single', x: n.x, y: n.y, z: n.z,
                    params: {
                        N: n.params?.N || 5, target_len: n.params?.target_len || 1000,
                        scale: n.params?.scale !== undefined ? n.params.scale : 1.0,
                        stretch: n.params?.stretch !== undefined ? n.params.stretch : 1.0,
                        angles: n.params?.angles ? [...n.params.angles] : [0, 0, 0],
                        showRight: n.params?.showRight ?? true, showS: n.params?.showS ?? true,
                        showLeft: n.params?.showLeft ?? true, showSLeft: n.params?.showSLeft ?? true,
                        rightSub: n.params?.rightSub || { height: 100, width: 100 },
                        leftSub: n.params?.leftSub || { height: 100, width: 100 },
                        sRightSub: n.params?.sRightSub || { height: 100, width: 100 },
                        sLeftSub: n.params?.sLeftSub || { height: 100, width: 100 }
                    },
                    quantumState: { intensity: 0, psi_real: 0, psi_imag: 0 }
                });
            });
            if (data.edges) {
                data.edges.forEach(e => { if (getNode(e.from) && getNode(e.to)) graph.edges.push({ from: e.from, to: e.to, weight: e.weight ?? 0.5 }); });
            }
            updateAllNodes();
            selectedNodes = []; selectedPart = null; transformControls.detach();
            updateSelectionHighlights(); renderProperties(null); sendDataToPythonCore();
        } catch(err) { alert('Ошибка загрузки: ' + err.message); }
    };
    reader.readAsText(file);
    e.target.value = '';
}

// ============================================================
// 11. ОТОБРАЖЕНИЕ СВОЙСТВ (ПАНЕЛЬ СПРАВА)
// ============================================================
function renderProperties(id) {
    const container = document.getElementById('propContent');
    if (selectedNodes.length === 0) { container.innerHTML = '<div class="empty">Выберите сфираль или элемент</div>'; return; }

    if (selectedNodes.length > 1) {
        let cx = 0, cy = 0, cz = 0;
        const targetNodes = selectedNodes.map(nid => getNode(nid)).filter(Boolean);
        targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
        cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

        container.innerHTML = `
            <div class="prop-group highlight">📦 Выделено: <b>${selectedNodes.length} шт.</b></div>
            <div class="prop-group"><label>IDs группы</label><input type="text" value="${selectedNodes.join(', ')}" disabled /></div>
            <div class="prop-group" style="background:#1f2d4a; padding:6px; border-radius:4px; margin-top:4px;">
                <label style="color:#00ffaa; font-weight:bold;">Центр группы (Pivot):</label>
                <div style="font-size:0.75rem; color:#f0f4f8;">X: ${cx.toFixed(1)} | Y: ${cy.toFixed(1)} | Z: ${cz.toFixed(1)}</div>
            </div>
        `;
        return;
    }

    const node = getNode(id);
    if (!node) { container.innerHTML = '<div class="empty">Выберите сфираль или элемент</div>'; return; }
    const p = node.params;

    if (selectedPart) {
        let subKey = 'rightSub';
        if (selectedPart === 'left') subKey = 'leftSub';
        else if (selectedPart === 's') subKey = 'sRightSub';
        else if (selectedPart === 'sLeft') subKey = 'sLeftSub';

        if (!node.params[subKey]) node.params[subKey] = { height: 100, width: 100 };
        const sub = node.params[subKey];

        container.innerHTML = `
            <div class="prop-group highlight">🎯 Подобъект: ${selectedPart}</div>
            <div class="prop-group">
                <label>Сжатие по высоте (%)</label>
                <input type="number" id="subHeight" class="auto-update-sub" value="${sub.height}" min="10" max="500" step="5" />
            </div>
            <div class="prop-group">
                <label>Сжатие по ширине (%)</label>
                <input type="number" id="subWidth" class="auto-update-sub" value="${sub.width}" min="10" max="500" step="5" />
            </div>
        `;

        const updateSubPartLive = () => {
            const h = parseFloat(document.getElementById('subHeight').value);
            const w = parseFloat(document.getElementById('subWidth').value);
            let changed = false;
            if (!isNaN(h) && sub.height !== h) { sub.height = h; changed = true; }
            if (!isNaN(w) && sub.width !== w) { sub.width = w; changed = true; }
            if (changed) { updateNodeVisual(node); updateEdges(); updateStats(); sendDataToPythonCore(); }
        };

        document.getElementById('subHeight').addEventListener('input', updateSubPartLive);
        document.getElementById('subWidth').addEventListener('input', updateSubPartLive);
        document.getElementById('subHeight').addEventListener('change', saveState);
        document.getElementById('subWidth').addEventListener('change', saveState);
        return;
    }

    container.innerHTML = `
        <div class="prop-group highlight">📦 Сфираль [ID: ${node.id}]</div>
        <div class="prop-group">
            <label>Общий масштаб</label>
            <input type="number" id="propScale" value="${p.scale !== undefined ? p.scale : 1.0}" min="0.1" max="10.0" step="0.1" />
        </div>
        <div class="prop-group">
            <label>Пружина (Растяжение Z)</label>
            <input type="number" id="propStretch" value="${p.stretch !== undefined ? p.stretch : 1.0}" min="0.1" max="5.0" step="0.1" />
        </div>
    `;

    document.getElementById('propScale').addEventListener('input', (e) => {
        const sc = parseFloat(e.target.value);
        if (!isNaN(sc) && p.scale !== sc) {
            p.scale = sc;
            updateNodeVisual(node);
            updateEdges();
            updateStats();
            sendDataPythonCoreThrottled();
        }
    });
    document.getElementById('propScale').addEventListener('change', saveState);

    document.getElementById('propStretch').addEventListener('input', (e) => {
        const st = parseFloat(e.target.value);
        if (!isNaN(st) && p.stretch !== st) {
            p.stretch = st;
            updateNodeVisual(node);
            updateEdges();
            updateStats();
            sendDataPythonCoreThrottled();
        }
    });
    document.getElementById('propStretch').addEventListener('change', saveState);
}

// ============================================================
// 12. ИНИЦИАЛИЗАЦИЯ
// ============================================================
function init() {
    new UIManager();
    buildSingleInitialSfiral();
    resizeRenderer();
    saveState();
    animate();
}

init();