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

// Увеличенная яркость, насыщенность и толщина линий для идеальной видимости
const batchLines = {
    right: new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff3333, linewidth: 3, transparent: true, opacity: 1.0 })),
    left: new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x00c0ff, linewidth: 3, transparent: true, opacity: 1.0 })),
    s: new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffea00, linewidth: 3, transparent: true, opacity: 1.0 }))
};

// Кэш геометрий сфиралей с учетом флагов отображения витков
const geometryCache = new Map();

function getCachedSfiralGeometries(N, scale, stretch, subParams, showRight, showLeft) {
    const key = `${N}_${scale}_${stretch}_${showRight}_${showLeft}_${JSON.stringify(subParams)}`;
    if (geometryCache.has(key)) return geometryCache.get(key);

    const R = (60 + N * 2) * scale;
    const H = (80 + N * 2) * scale;
    const rightBranch = generateRightBranch(R, H);
    
    const rightPts = applySubScale(rightBranch.mainPts, subParams.rightSub, stretch);
    const sRightPts = applySubScale(rightBranch.sPts, subParams.sRightSub, stretch);
    const leftBasePts = rightBranch.mainPts.map(p => new THREE.Vector3(-p.x, -p.y, -p.z));
    const sLeftBasePts = rightBranch.sPts.map(p => new THREE.Vector3(-p.x, -p.y, -p.z));
    const leftPts = applySubScale(leftBasePts, subParams.leftSub, stretch);
    const sLeftPts = applySubScale(sLeftBasePts, subParams.sLeftSub, stretch);

    const data = { rightPts, sRightPts, leftPts, sLeftPts };
    geometryCache.set(key, data);
    return data;
}

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
            angles: params?.angles ? [...params.angles] : [0, 0, 0],
            activeGate: params?.activeGate || 'H',
            showRight: params?.showRight !== undefined ? params.showRight : true,
            showS: params?.showS !== undefined ? params.showS : true,
            showLeft: params?.showLeft !== undefined ? params.showLeft : true,
            showSLeft: params?.showSLeft !== undefined ? params.showSLeft : true,
            rightSub: params?.rightSub ? { ...params.rightSub } : { height: 100 },
            leftSub: params?.leftSub ? { ...params.leftSub } : { height: 100 },
            sRightSub: params?.sRightSub ? { ...params.sRightSub } : { height: 100 },
            sLeftSub: params?.sLeftSub ? { ...params.sLeftSub } : { height: 100 }
        },
        entryPoint: null,
        exitPoint: null,
        quantumState: { intensity: 0, psi_real: 0, psi_imag: 0 }
    };
    graph.nodes.push(node);
    return node;
}

function addEdge(fromId, toId, weight, type = 'right_polarization') {
    if (fromId === toId) return null;
    if (graph.edges.some(e => (e.from === fromId && e.to === toId) || (e.from === toId && e.to === fromId))) return null;
    const edge = { 
        from: fromId, 
        to: toId, 
        weight: weight !== undefined ? weight : 0.5,
        type: type 
    };
    graph.edges.push(edge);
    return edge;
}

function removeNode(id) {
    graph.nodes = graph.nodes.filter(n => n.id !== id);
    graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);
}

function getNode(id) { return graph.nodes.find(n => n.id === id); }

function autoConnectStuckNodes() {
    if (graph.nodes.length > 50) return;
}

function compileTopologyToQuantumCircuit() {
    let circuitGates = [];
    graph.nodes.forEach(node => {
        const gate = node.params.activeGate || 'H';
        circuitGates.push(`${gate}(q${node.id})`);
    });
    graph.edges.forEach(edge => {
        circuitGates.push(`CNOT(q${edge.from}, q${edge.to})`);
    });

    const consoleEl = document.getElementById('console');
    if (consoleEl && graph.nodes.length > 0) {
        consoleEl.style.display = 'block';
        consoleEl.innerHTML += `
            <div class="line success">🧬 [Авто-Компилятор схемы]: Сгенерирован квантовый пайплайн[cite: 13]</div>
            <div class="line">🛠️ [Цепочка вентилей]: ${circuitGates.join(' — ')}[cite: 13]</div>
        `;
    }
}

// ============================================================
// 3. ОНЛАЙН-МОСТ С PYTHON-ЯДРОМ
// ============================================================
async function sendDataToPythonCore() {
    const payload = {
        model_name: "GIDEON-Realtime-Session",
        total_nodes: graph.nodes.length,
        nodes: graph.nodes.map(n => ({ id: n.id, x: n.x, y: n.y, z: n.z, params: n.params }))
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
            if (consoleEl) {
                consoleEl.style.display = 'block';
                consoleEl.innerHTML += `<div class="line success">⚡ [Ядро онлайн]: Сфиралей обработано: ${result.computed_nodes}[cite: 13]</div>`;
            }
            compileTopologyToQuantumCircuit();
        }
    } catch (err) {
        console.warn("⚠️ Локальное ядро не отвечает[cite: 13].");
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
canvas.style.touchAction = 'none';

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const ambient = new THREE.AmbientLight(0xffffff, 0.9);
scene.add(ambient);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
dirLight.position.set(1, 2, 1);
scene.add(dirLight);

const gridHelper = new THREE.GridHelper(1000, 20, 0x00e5ff, 0x1f2d4a);
scene.add(gridHelper);

const objectsGroup = new THREE.Group();
objectsGroup.name = "GIDEON_Fractal_Root_Container";
scene.add(objectsGroup);
scene.add(groupTransformProxy);

objectsGroup.add(batchLines.right, batchLines.left, batchLines.s);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 5000);
camera.position.set(600, 400, 800);
camera.lookAt(0, 0, 0);

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
transformControls.size = 0.9;
transformControls.space = 'local';
scene.add(transformControls);

let lastProxyPosition = new THREE.Vector3();
let lastProxyRotation = new THREE.Euler();

transformControls.addEventListener('dragging-changed', (event) => {
    controls.enabled = !event.value;
    if (event.value) {
        if (selectedNodes.length > 1) {
            let cx = 0, cy = 0, cz = 0;
            const targetNodes = selectedNodes.map(nid => getNode(nid)).filter(Boolean);
            targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
            cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

            groupTransformProxy.position.set(cx, cy, cz);
            groupTransformProxy.rotation.set(0, 0, 0);
            groupTransformProxy.updateMatrixWorld();
        }
        lastProxyPosition.copy(groupTransformProxy.position);
        lastProxyRotation.copy(groupTransformProxy.rotation);
    }
});

transformControls.addEventListener('change', () => {
    if (!transformControls.object) return;

    if (selectedNodes.length === 1) {
        const id = transformControls.object.userData.nodeId;
        const node = getNode(id);
        const group = meshMap.get(id);
        if (node && group) {
            if (selectedPart && transformControls.mode === 'translate') {
                let targetChild = null;
                group.children.forEach(child => {
                    if (child.userData && child.userData.part === selectedPart) {
                        targetChild = child;
                    }
                });
                if (targetChild) {
                    targetChild.position.copy(transformControls.object.position);
                }
            } else {
                node.x = transformControls.object.position.x;
                node.y = transformControls.object.position.y;
                node.z = transformControls.object.position.z;
                if (transformControls.mode === 'rotate') {
                    node.params.angles = [
                        THREE.MathUtils.radToDeg(group.rotation.x),
                        THREE.MathUtils.radToDeg(group.rotation.y),
                        THREE.MathUtils.radToDeg(group.rotation.z)
                    ];
                }
                updateBottomBarValues(node);
                updateEdges();
                autoConnectStuckNodes();
            }
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
        autoConnectStuckNodes();
    }
});

transformControls.addEventListener('mouseUp', () => {
    autoConnectStuckNodes();
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
// 5. ВИЗУАЛИЗАЦИЯ СФИРАЛЕЙ
// ============================================================
function applySubScale(pts, subParams, stretch = 1.0) {
    if (!subParams && stretch === 1.0) return pts;
    const scaleH = (subParams?.height !== undefined ? subParams.height : 100) / 100.0;
    return pts.map(p => new THREE.Vector3(p.x, p.y * scaleH, p.z * stretch));
}

function createSfiralGroup(node) {
    const group = new THREE.Group();
    const nodeScale = node.params.scale !== undefined ? node.params.scale : 1.0;
    const stretch = node.params.stretch !== undefined ? node.params.stretch : 1.0;
    const N = node.params.N || 5;

    const { rightPts, sRightPts, leftPts, sLeftPts } = getCachedSfiralGeometries(
        N, nodeScale, stretch, node.params, node.params.showRight, node.params.showLeft
    );

    if (node.params.showRight) {
        const rightLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(rightPts),
            new THREE.LineBasicMaterial({ color: 0xff3333, transparent: true, opacity: 1.0 })
        );
        rightLine.userData = { nodeId: node.id, part: 'right' };
        group.add(rightLine);
    }
    if (node.params.showS) {
        const sLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(sRightPts),
            new THREE.LineBasicMaterial({ color: 0xffea00, transparent: true, opacity: 1.0 })
        );
        sLine.userData = { nodeId: node.id, part: 's', isSLoopQuantum: true };
        group.add(sLine);
    }
    if (node.params.showLeft) {
        const leftLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(leftPts),
            new THREE.LineBasicMaterial({ color: 0x00c0ff, transparent: true, opacity: 1.0 })
        );
        leftLine.userData = { nodeId: node.id, part: 'left' };
        group.add(leftLine);
    }
    if (node.params.showSLeft) {
        const sLeftLine = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(sLeftPts),
            new THREE.LineBasicMaterial({ color: 0xffea00, transparent: true, opacity: 1.0 })
        );
        sLeftLine.userData = { nodeId: node.id, part: 'sLeft', isSLoopQuantum: true };
        group.add(sLeftLine);
    }

    const intensity = node.quantumState?.intensity || 0;
    const isExcited = intensity > 0.3;
    const sphereColor = isExcited ? 0x00ffcc : 0xffaa00;
    const sphereRadius = (5 + Math.min(intensity * 8, 14)) * nodeScale;
    const centerGeo = new THREE.SphereGeometry(sphereRadius, 10, 10);
    const centerMat = new THREE.MeshBasicMaterial({ color: sphereColor, transparent: true, opacity: isExcited ? 1.0 : 0.85 });
    const center = new THREE.Mesh(centerGeo, centerMat);
    center.userData = { nodeId: node.id, part: 'center' };
    group.add(center);

    const angles = node.params.angles || [0, 0, 0];
    group.rotation.x = THREE.MathUtils.degToRad(angles[0]);
    group.rotation.y = THREE.MathUtils.degToRad(angles[1]);
    group.rotation.z = THREE.MathUtils.degToRad(angles[2]);

    node.entryPoint = rightPts.length > 0 ? rightPts[0].clone() : new THREE.Vector3(0, 0, 0);
    node.exitPoint = leftPts.length > 0 ? leftPts[0].clone() : new THREE.Vector3(0, 0, 0);

    group.userData.nodeId = node.id;
    return group;
}

const meshMap = new Map();
let autoEdgeLines = [];
let chronoBridgeLines = [];

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
    if (chronoBridgeLines.length > 0) {
        chronoBridgeLines.forEach(line => objectsGroup.remove(line));
        chronoBridgeLines = [];
    }

    const points = { right: [], left: [], s: [] };
    const MAX_CONNECTION_DIST = 250;

    graph.edges.forEach(edge => {
        const fromNode = getNode(edge.from);
        const toNode = getNode(edge.to);
        const fromGroup = meshMap.get(edge.from);
        const toGroup = meshMap.get(edge.to);
        if (!fromNode || !toNode || !fromGroup || !toGroup) return;

        const N1 = fromNode.params.N || 5, sc1 = fromNode.params.scale ?? 1.0, st1 = fromNode.params.stretch ?? 1.0;
        const geom1 = getCachedSfiralGeometries(N1, sc1, st1, fromNode.params, fromNode.params.showRight, fromNode.params.showLeft);
        
        const N2 = toNode.params.N || 5, sc2 = toNode.params.scale ?? 1.0, st2 = toNode.params.stretch ?? 1.0;
        const geom2 = getCachedSfiralGeometries(N2, sc2, st2, toNode.params, toNode.params.showRight, toNode.params.showLeft);

        const rot1 = fromNode.params.angles || [0, 0, 0];
        const rot2 = toNode.params.angles || [0, 0, 0];
        const diffY = Math.abs((rot2[1] - rot1[1]) % 360);
        const diffZ = Math.abs((rot2[2] - rot1[2]) % 360);

        const isFlipped180 = (Math.abs(diffY - 180) < 5 || Math.abs(diffY - 540) < 5) && 
                             (Math.abs(diffZ - 180) < 5 || Math.abs(diffZ - 540) < 5);

        const isNotFlipped = (diffY < 5 || Math.abs(diffY - 360) < 5) && 
                             (diffZ < 5 || Math.abs(diffZ - 360) < 5);

        const r1_free = geom1.rightPts[0].clone().applyEuler(fromGroup.rotation).add(fromGroup.position);
        const l1_free = geom1.leftPts[0].clone().applyEuler(fromGroup.rotation).add(fromGroup.position);

        const r2_free = geom2.rightPts[0].clone().applyEuler(toGroup.rotation).add(toGroup.position);
        const l2_free = geom2.leftPts[0].clone().applyEuler(toGroup.rotation).add(toGroup.position);

        if (isFlipped180) {
            if (fromNode.params.showRight && toNode.params.showRight) {
                const distR = r1_free.distanceTo(r2_free);
                if (distR < MAX_CONNECTION_DIST) {
                    points.right.push(r1_free, r2_free);
                }
            }
            if (fromNode.params.showLeft && toNode.params.showLeft) {
                const distL = l1_free.distanceTo(l2_free);
                if (distL < MAX_CONNECTION_DIST) {
                    points.left.push(l1_free, l2_free);
                }
            }
        } else if (isNotFlipped) {
            if (fromNode.params.showRight && toNode.params.showLeft) {
                const distRL = r1_free.distanceTo(l2_free);
                if (distRL < MAX_CONNECTION_DIST) {
                    points.right.push(r1_free, l2_free);
                }
            }
            if (fromNode.params.showLeft && toNode.params.showRight) {
                const distLR = l1_free.distanceTo(r2_free);
                if (distLR < MAX_CONNECTION_DIST) {
                    points.left.push(l1_free, r2_free);
                }
            }
        }
    });

    Object.keys(batchLines).forEach(k => {
        batchLines[k].geometry.dispose();
        batchLines[k].geometry = new THREE.BufferGeometry().setFromPoints(points[k]);
    });

    if (graph.nodes.length <= 50) {
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
            let mat = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.7 });
            let line = new THREE.Line(geo, mat);
            line.userData = { isChronoBridge: true };
            objectsGroup.add(line);
            chronoBridgeLines.push(line);
        });
    }

    drawAutoEdges();
    updateStats();
}

function drawAutoEdges() {
    if (autoEdgeLines.length > 0) {
        autoEdgeLines.forEach(line => objectsGroup.remove(line));
        autoEdgeLines = [];
    }

    if (graph.nodes.length > 50) return;

    const threshold = 200;
    const nodeIds = graph.nodes.map(n => n.id);
    for (let i = 0; i < nodeIds.length; i++) {
        for (let j = 0; j < nodeIds.length; j++) {
            if (i === j) continue;
            const n1 = getNode(nodeIds[i]);
            const n2 = getNode(nodeIds[j]);
            if (!n1 || !n2) continue;
            
            const hasEdge = graph.edges.some(e => (e.from === n1.id && e.to === n2.id) || (e.from === n2.id && e.to === n1.id));
            if (hasEdge) continue;

            const g1 = meshMap.get(n1.id);
            const g2 = meshMap.get(n2.id);
            if (!g1 || !g2) continue;

            const N1 = n1.params.N || 5, sc1 = n1.params.scale ?? 1.0, st1 = n1.params.stretch ?? 1.0;
            const geom1 = getCachedSfiralGeometries(N1, sc1, st1, n1.params, n1.params.showRight, n1.params.showLeft);
            
            const N2 = n2.params.N || 5, sc2 = n2.params.scale ?? 1.0, st2 = n2.params.stretch ?? 1.0;
            const geom2 = getCachedSfiralGeometries(N2, sc2, st2, n2.params, n2.params.showRight, n2.params.showLeft);

            const rot1 = n1.params.angles || [0, 0, 0];
            const rot2 = n2.params.angles || [0, 0, 0];
            const diffY = Math.abs((rot2[1] - rot1[1]) % 360);
            const diffZ = Math.abs((rot2[2] - rot1[2]) % 360);

            const isFlipped180 = (Math.abs(diffY - 180) < 5 || Math.abs(diffY - 540) < 5) && 
                                 (Math.abs(diffZ - 180) < 5 || Math.abs(diffZ - 540) < 5);

            const isNotFlipped = (diffY < 5 || Math.abs(diffY - 360) < 5) && 
                                 (diffZ < 5 || Math.abs(diffZ - 360) < 5);

            const r1_free = geom1.rightPts[0].clone().applyEuler(g1.rotation).add(g1.position);
            const l1_free = geom1.leftPts[0].clone().applyEuler(g1.rotation).add(g1.position);

            const r2_free = geom2.rightPts[0].clone().applyEuler(g2.rotation).add(g2.position);
            const l2_free = geom2.leftPts[0].clone().applyEuler(g2.rotation).add(g2.position);

            const checkPointsPairs = [];

            if (isFlipped180) {
                if (n1.params.showRight && n2.params.showRight) {
                    checkPointsPairs.push({ p1: r1_free, p2: r2_free, color: 0xff3333 });
                }
                if (n1.params.showLeft && n2.params.showLeft) {
                    checkPointsPairs.push({ p1: l1_free, p2: l2_free, color: 0x00c0ff });
                }
            } else if (isNotFlipped) {
                if (n1.params.showRight && n2.params.showLeft) {
                    checkPointsPairs.push({ p1: r1_free, p2: l2_free, color: 0xff3333 });
                }
                if (n1.params.showLeft && n2.params.showRight) {
                    checkPointsPairs.push({ p1: l1_free, p2: r2_free, color: 0x00c0ff });
                }
            }

            checkPointsPairs.forEach(pair => {
                const dist = pair.p1.distanceTo(pair.p2);
                if (dist < threshold) {
                    const geo = new THREE.BufferGeometry().setFromPoints([pair.p1, pair.p2]);
                    const mat = new THREE.LineDashedMaterial({ color: pair.color, dashSize: 6, gapSize: 3, transparent: true, opacity: 0.9 });
                    const line = new THREE.Line(geo, mat);
                    line.computeLineDistances();
                    objectsGroup.add(line);
                    autoEdgeLines.push(line);
                }
            });
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
    let leftCount = graph.edges.filter(e => e.type === 'left_polarization').length;
    let rightCount = graph.edges.filter(e => e.type === 'right_polarization').length;
    let sLoopCount = graph.edges.filter(e => e.type === 's_loop').length;
    
    graph.nodes.forEach(n => {
        if (n.params.showS) sLoopCount++;
        if (n.params.showSLeft) sLoopCount++;
    });

    document.getElementById('edgeCount').textContent = `Хроноквантов: ${totalEdges + graph.nodes.length * 2} (L:${leftCount} | R:${rightCount} | S:${sLoopCount})`;
    let totalParams = 0;
    graph.nodes.forEach(n => { totalParams += 20; });
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
                    child.material.opacity = 0.75;
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
        } else {
            transformControls.detach();
        }
    } else if (selectedNodes.length > 1) {
        let cx = 0, cy = 0, cz = 0;
        const targetNodes = selectedNodes.map(nid => getNode(nid)).filter(Boolean);
        targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
        cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

        groupTransformProxy.position.set(cx, cy, cz);
        groupTransformProxy.rotation.set(0, 0, 0);
        groupTransformProxy.updateMatrixWorld();

        lastProxyPosition.copy(groupTransformProxy.position);
        lastProxyRotation.copy(groupTransformProxy.rotation);

        transformControls.attach(groupTransformProxy);
        updateBottomBarValues(null);
    } else {
        transformControls.detach();
        updateBottomBarValues(null);
    }
}

function centerSelectedToOrigin() {
    if (selectedNodes.length === 0) {
        alert('Выберите сфираль или группу для переноса в центр');
        return;
    }
    saveState();

    let cx = 0, cy = 0, cz = 0;
    const targetNodes = selectedNodes.map(nid => getNode(nid)).filter(Boolean);
    if (targetNodes.length === 0) return;

    targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
    cx /= targetNodes.length; 
    cy /= targetNodes.length; 
    cz /= targetNodes.length;

    targetNodes.forEach(node => {
        node.x -= cx;
        node.y -= cy;
        node.z -= cz;
        updateNodeVisual(node);
    });

    updateEdges();
    updateSelectionHighlights();
    sendDataToPythonCore();
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
// 7. ПЕРЕКЛЮЧЕНИЕ ПРОЕКЦИЙ ВИДОВ
// ============================================================
function switchView(view) {
    document.querySelectorAll('#view-tools button').forEach(b => b.classList.remove('view-active'));
    const activeBtn = document.querySelector(`#view-tools button[data-view="${view}"]`);
    if (activeBtn) activeBtn.classList.add('view-active');

    let pos = new THREE.Vector3(600, 400, 800);
    const target = new THREE.Vector3(0, 0, 0);
    const dist = 700;

    switch (view) {
        case 'perspective': pos.set(600, 400, 800); break;
        case 'top': pos.set(0, dist, 0.01); break;
        case 'front': pos.set(0, 0, dist); break;
        case 'side': pos.set(dist, 0, 0); break;
    }

    camera.position.copy(pos);
    controls.target.copy(target);
    controls.update();
}

// ============================================================
// 8. БУФЕР ОБМЕНА
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
            activeGate: src.params.activeGate,
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
            addEdge(newFrom, newTo, edge.weight, edge.type);
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

function applyScaleAndStretchToNodes(nodeIds, newScale, newStretch) {
    saveState();
    const targetNodes = nodeIds.map(nid => getNode(nid)).filter(Boolean);
    if (targetNodes.length === 0) return;

    let cx = 0, cy = 0, cz = 0;
    targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
    cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

    const sampleNode = targetNodes[0];
    const oldScale = sampleNode.params.scale ?? 1.0;
    const oldStretch = sampleNode.params.stretch ?? 1.0;

    targetNodes.forEach(node => {
        if (newScale !== undefined && oldScale > 0) {
            const scaleRatio = newScale / oldScale;
            node.x = cx + (node.x - cx) * scaleRatio;
            node.y = cy + (node.y - cy) * scaleRatio;
            node.z = cz + (node.z - cz) * scaleRatio;
            node.params.scale = newScale;
        }

        if (newStretch !== undefined && oldStretch > 0) {
            const stretchRatio = newStretch / oldStretch;
            const relativeZ = node.z - cz;
            node.z = cz + relativeZ * stretchRatio;
            node.params.stretch = newStretch;
        }

        updateNodeVisual(node);
    });

    updateEdges();
    sendDataPythonCoreThrottled();
}

// ============================================================
// 9. UI-МЕНЕДЖЕР И КВАНТОВЫЕ ВЕНТИЛИ (С ПОДДЕРЖКОЙ TOUCH)
// ============================================================
class UIManager {
    constructor() {
        this.bindExistingToolButtons();
        this.setupQuantumGates();
        this.setupEventListeners();
        this.setupKeyboardShortcuts();
    }

    bindExistingToolButtons() {
        const transBtn = document.getElementById('toolTranslateBtn');
        const rotBtn = document.getElementById('toolRotateBtn');
        const centerBtn = document.getElementById('toolCenterBtn');

        if (transBtn) {
            transBtn.classList.add('active');
            transBtn.addEventListener('click', () => {
                transformControls.setMode('translate');
                this.setActiveTool('translate');
            });
            transBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (selectedNodes.length === 0) { alert('Выберите сфираль или группу'); return; }
                openMoveDialog();
            });
        }

        if (rotBtn) {
            rotBtn.addEventListener('click', () => {
                transformControls.setMode('rotate');
                this.setActiveTool('rotate');
            });
            rotBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (selectedNodes.length === 0) { alert('Выберите сфираль или группу'); return; }
                openRotateDialog();
            });
        }

        if (centerBtn) {
            centerBtn.addEventListener('click', () => { centerSelectedToOrigin(); });
        }
    }

    setupQuantumGates() {
        document.getElementById('gateHadamard')?.addEventListener('click', () => {
            if (selectedNodes.length === 0) { alert('Выберите сфираль'); return; }
            saveState();
            selectedNodes.forEach(id => {
                const node = getNode(id);
                if (node) {
                    node.params.activeGate = 'H';
                    node.quantumState.intensity = 0.8;
                    updateNodeVisual(node);
                }
            });
            updateEdges(); updateStats(); sendDataToPythonCore();
        });

        document.getElementById('gateSTransition')?.addEventListener('click', () => {
            if (selectedNodes.length === 0) { alert('Выберите сфираль'); return; }
            saveState();
            selectedNodes.forEach(id => {
                const node = getNode(id);
                if (node) {
                    node.params.activeGate = 'S_TRANSITION';
                    const tempShow = node.params.showRight;
                    node.params.showRight = node.params.showLeft;
                    node.params.showLeft = tempShow;
                    node.params.angles[2] = (node.params.angles[2] + 180) % 360;
                    updateNodeVisual(node);
                }
            });
            updateEdges(); updateStats(); sendDataToPythonCore();
        });

        document.getElementById('gateX')?.addEventListener('click', () => {
            if (selectedNodes.length === 0) { alert('Выберите сфираль'); return; }
            saveState();
            selectedNodes.forEach(id => {
                const node = getNode(id);
                if (node) {
                    node.params.activeGate = 'X';
                    const temp = node.params.showRight;
                    node.params.showRight = node.params.showLeft;
                    node.params.showLeft = temp;
                    updateNodeVisual(node);
                }
            });
            updateEdges(); updateStats(); sendDataToPythonCore();
        });

        document.getElementById('gateCNOT')?.addEventListener('click', () => {
            if (selectedNodes.length !== 2) { alert('Выберите ровно две сфирали'); return; }
            saveState();
            const edge = addEdge(selectedNodes[0], selectedNodes[1], 1.0, 'right_polarization');
            if (edge) { updateEdges(); updateStats(); sendDataToPythonCore(); }
        });
    }

    setActiveTool(mode) {
        const transBtn = document.getElementById('toolTranslateBtn');
        const rotBtn = document.getElementById('toolRotateBtn');
        if (transBtn) transBtn.classList.remove('active');
        if (rotBtn) rotBtn.classList.remove('active');
        if (mode === 'translate' && transBtn) transBtn.classList.add('active');
        if (mode === 'rotate' && rotBtn) rotBtn.classList.add('active');
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
                el.addEventListener('input', () => { applyModalPositionLive(); autoConnectStuckNodes(); });
                el.addEventListener('change', () => { saveState(); sendDataToPythonCore(); });
            }
        });

        ['modalRotX', 'modalRotY', 'modalRotZ'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', () => { applyModalRotationLive(); autoConnectStuckNodes(); });
                el.addEventListener('change', () => { saveState(); sendDataToPythonCore(); });
            }
        });

        document.getElementById('addNodeBtn')?.addEventListener('click', addNodeHandler);
        document.getElementById('deleteBtn')?.addEventListener('click', deleteSelected);
        document.getElementById('connectBtn')?.addEventListener('click', connectSelected);
        document.getElementById('copyGroupBtn')?.addEventListener('click', copySelected);
        document.getElementById('saveModelBtn')?.addEventListener('click', saveModel);
        document.getElementById('loadModelBtn')?.addEventListener('click', () => document.getElementById('fileInput').click());
        document.getElementById('fileInput')?.addEventListener('change', loadModel);
        document.getElementById('fractalPresetBtn')?.addEventListener('click', buildFractalComposition);

        document.querySelectorAll('#view-tools button[data-view]').forEach(btn => {
            btn.addEventListener('click', () => { switchView(btn.getAttribute('data-view')); });
        });

        this.setupMouseSelection();
    }

    setupMouseSelection() {
        let touchDownPos = { x: 0, y: 0 };
        let touchTimer = null;
        let isLongPress = false;

        renderer.domElement.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                const touch = e.touches[0];
                touchDownPos.x = touch.clientX;
                touchDownPos.y = touch.clientY;
                isLongPress = false;
                
                const hitData = getObjectUnderMouse(touch.clientX, touch.clientY);
                if (hitData) {
                    touchTimer = setTimeout(() => {
                        isLongPress = true;
                        selectedNodes = [hitData.nodeId];
                        selectedPart = hitData.part;
                        updateSelectionHighlights();
                        renderProperties(hitData.nodeId);
                        openRotateDialog();
                    }, 650);
                }
            }
        }, { passive: true });

        renderer.domElement.addEventListener('touchmove', (e) => {
            if (e.touches.length === 1) {
                const touch = e.touches[0];
                const dx = touch.clientX - touchDownPos.x;
                const dy = touch.clientY - touchDownPos.y;
                if (Math.sqrt(dx * dx + dy * dy) > 10 && touchTimer) {
                    clearTimeout(touchTimer);
                    touchTimer = null;
                }
            }
        }, { passive: true });

        renderer.domElement.addEventListener('touchend', (e) => {
            if (touchTimer) { clearTimeout(touchTimer); touchTimer = null; }
        }, { passive: true });

        const selectionRect = document.getElementById('selectionRect');
        let mouseDownPos = { x: 0, y: 0 };
        let mouseDownObjectId = null;
        let mouseDownPart = null;
        let isBoxSelecting = false;
        let boxStart = { x: 0, y: 0 };

        renderer.domElement.addEventListener('pointerdown', (e) => {
            if (e.button === 2) {
                e.preventDefault();
                const hitData = getObjectUnderMouse(e.clientX, e.clientY);
                if (hitData) {
                    selectedNodes = [hitData.nodeId];
                    selectedPart = hitData.part;
                    updateSelectionHighlights();
                    renderProperties(hitData.nodeId);
                    openRotateDialog();
                }
                return;
            }

            if (e.button !== 0 || isLongPress) return;
            document.getElementById('moveDialogModal').style.display = 'none';
            document.getElementById('rotateDialogModal').style.display = 'none';

            mouseDownPos.x = e.clientX;
            mouseDownPos.y = e.clientY;
            const hitData = getObjectUnderMouse(e.clientX, e.clientY);
            mouseDownObjectId = hitData ? hitData.nodeId : null;
            mouseDownPart = hitData ? hitData.part : null;
            isBoxSelecting = false;

            if (window.isBoxSelectMode && mouseDownObjectId === null && !transformControls.dragging) {
                isBoxSelecting = true;
                boxStart.x = e.clientX;
                boxStart.y = e.clientY;
                if (selectionRect) {
                    selectionRect.style.display = 'block';
                    selectionRect.style.left = boxStart.x + 'px';
                    selectionRect.style.top = boxStart.y + 'px';
                    selectionRect.style.width = '0px';
                    selectionRect.style.height = '0px';
                }
                controls.enabled = false;
            }
        });

        renderer.domElement.addEventListener('pointermove', (e) => {
            if (isBoxSelecting && selectionRect) {
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
            if ((e.button !== 0 && e.button !== 2) || isLongPress) return;
            const dx = e.clientX - mouseDownPos.x;
            const dy = e.clientY - mouseDownPos.y;
            const isClick = Math.sqrt(dx * dx + dy * dy) < 5;

            if (isBoxSelecting) {
                isBoxSelecting = false;
                if (selectionRect) selectionRect.style.display = 'none';
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
                    if (ndcX >= minX && ndcX <= maxX && ndcY >= minY && ndcY <= maxY) {
                        newSelection.push(id);
                    }
                });

                if (e.ctrlKey || e.shiftKey) {
                    selectedNodes = [...new Set([...selectedNodes, ...newSelection])];
                } else {
                    selectedNodes = newSelection;
                }

                selectedPart = null;
                updateSelectionHighlights();
                renderProperties(selectedNodes.length === 1 ? selectedNodes[0] : null);
                controls.enabled = true;
                return;
            }

            if (isClick && e.button === 0) {
                if (mouseDownObjectId !== null) {
                    const id = mouseDownObjectId;
                    if (e.ctrlKey || e.shiftKey) {
                        if (selectedNodes.includes(id)) {
                            selectedNodes = selectedNodes.filter(nid => nid !== id);
                        } else {
                            selectedNodes.push(id);
                        }
                        selectedPart = null;
                    } else {
                        selectedNodes = [id];
                        selectedPart = mouseDownPart;
                    }
                    updateSelectionHighlights();
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

            if (selectedNodes.length > 0) {
                let sampleNode = getNode(selectedNodes[0]);
                if (sampleNode) {
                    let targetScale = sampleNode.params.scale ?? 1.0;
                    let targetStretch = sampleNode.params.stretch ?? 1.0;
                    let changed = false;

                    if (key === '=' || key === '+') { targetScale = Math.min(10.0, targetScale + 0.1); changed = true; }
                    else if (key === '-' || key === '_') { targetScale = Math.max(0.1, targetScale - 0.1); changed = true; }
                    else if (key === ']') { targetStretch = Math.min(5.0, targetStretch + 0.1); changed = true; }
                    else if (key === '[') { targetStretch = Math.max(0.1, targetStretch - 0.1); changed = true; }

                    if (changed) {
                        e.preventDefault();
                        applyScaleAndStretchToNodes(
                            selectedNodes,
                            targetScale !== sampleNode.params.scale ? targetScale : undefined,
                            targetStretch !== sampleNode.params.stretch ? targetStretch : undefined
                        );
                        renderProperties(selectedNodes.length === 1 ? selectedNodes[0] : null);
                        return;
                    }
                }
            }

            if (e.ctrlKey && key === 'c') { e.preventDefault(); copySelected(); }
            else if (e.ctrlKey && key === 'v') { e.preventDefault(); pasteClipboard(); }
            else if (e.key === 'Delete' || e.key === 'Del') { e.preventDefault(); deleteSelected(); }
            else if (e.key === 'Escape') {
                selectedNodes = []; selectedPart = null;
                transformControls.detach(); updateSelectionHighlights(); renderProperties(null);
            }
        }, true);
    }
}

// ============================================================
// 10. ОБРАБОТЧИКИ ДЕЙСТВИЙ
// ============================================================
function updateBottomBarValues(node) {
    if (!node) return;
    document.getElementById('botPosX').value = Math.round(node.x);
    document.getElementById('botPosY').value = Math.round(node.y);
    document.getElementById('botPosZ').value = Math.round(node.z);
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
        if (!isNaN(px)) node.x = px;
        if (!isNaN(py)) node.y = py;
        if (!isNaN(pz)) node.z = pz;
        updateNodeVisual(node); updateBottomBarValues(node); updateEdges();
    } else {
        let cx = 0, cy = 0, cz = 0;
        const targetNodes = selectedNodes.map(nid => getNode(nid)).filter(Boolean);
        targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
        cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

        const targetX = !isNaN(px) ? px : cx;
        const targetY = !isNaN(py) ? py : cy;
        const targetZ = !isNaN(pz) ? pz : cz;
        const dx = targetX - cx, dy = targetY - cy, dz = targetZ - cz;

        if (dx !== 0 || dy !== 0 || dz !== 0) {
            targetNodes.forEach(node => {
                node.x += dx; node.y += dy; node.z += dz;
                updateNodeVisual(node);
            });
            updateEdges();
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
        const group = meshMap.get(selectedNodes[0]);
        if (!node || !group) return;
        if (!isNaN(rx)) node.params.angles[0] = rx;
        if (!isNaN(ry)) node.params.angles[1] = ry;
        if (!isNaN(rz)) node.params.angles[2] = rz;
        group.rotation.set(
            THREE.MathUtils.degToRad(node.params.angles[0]),
            THREE.MathUtils.degToRad(node.params.angles[1]),
            THREE.MathUtils.degToRad(node.params.angles[2])
        );
        updateBottomBarValues(node); updateEdges();
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
    }
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

function addNodeHandler() {
    saveState();
    let nextX = 0, nextZ = 0;
    if (graph.nodes.length > 0) {
        const lastNode = graph.nodes[graph.nodes.length - 1];
        nextX = lastNode.x - 140; nextZ = lastNode.z - 180;
    }
    const node = addNode('Single', nextX, 0, nextZ, { N: 5, target_len: 1000, scale: 1.0, stretch: 1.0, angles: [0, 0, 0], activeGate: 'H' });
    updateNodeVisual(node); updateEdges(); updateStats();
    selectedNodes = [node.id]; selectedPart = null;
    updateSelectionHighlights(); renderProperties(node.id); sendDataToPythonCore();
}

function deleteSelected() {
    if (selectedNodes.length === 0) return alert('Выберите сфирали');
    saveState();

    if (selectedPart && selectedNodes.length === 1) {
        const node = getNode(selectedNodes[0]);
        if (node) {
            if (selectedPart === 'right') node.params.showRight = false;
            else if (selectedPart === 's' || selectedPart === 'sRight') node.params.showS = false;
            else if (selectedPart === 'left') node.params.showLeft = false;
            else if (selectedPart === 'sLeft') node.params.showSLeft = false;

            updateNodeVisual(node); selectedPart = null;
            updateSelectionHighlights(); renderProperties(node.id); sendDataToPythonCore();
            return;
        }
    }

    selectedNodes.forEach(id => {
        removeNode(id);
        if (meshMap.has(id)) { objectsGroup.remove(meshMap.get(id)); meshMap.delete(id); }
    });
    selectedNodes = []; selectedPart = null; transformControls.detach();
    updateEdges(); updateStats(); renderProperties(null);
    updateSelectionHighlights(); sendDataToPythonCore();
}

function connectSelected() {
    if (selectedNodes.length === 2) {
        saveState();
        const edge = addEdge(selectedNodes[0], selectedNodes[1], 1.0, 'right_polarization');
        if (edge) { updateEdges(); updateStats(); sendDataToPythonCore(); }
        else { alert('Связь уже существует'); }
    } else {
        alert('Выделите ровно две сфирали');
    }
}

function buildFractalComposition() {
    saveState();
    graph.nodes = []; graph.edges = []; nextId = 1;
    const n1 = addNode('Single', 0, 0, 0, { N: 5, target_len: 1000, scale: 1.0, stretch: 1.0, angles: [0, 0, 0], activeGate: 'H' });
    const n2 = addNode('Single', -140, 0, -180, { N: 5, target_len: 1000, scale: 1.0, stretch: 1.0, angles: [0, 0, 0], activeGate: 'H' });
    addEdge(n1.id, n2.id, 1.0, 'right_polarization');
    updateAllNodes(); selectedNodes = [n1.id]; selectedPart = null;
    updateSelectionHighlights(); renderProperties(n1.id); sendDataToPythonCore();
}

function saveModel() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(graph, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "gideon_sfiral_model.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

function loadModel(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            const loadedData = JSON.parse(event.target.result);
            if (loadedData && Array.isArray(loadedData.nodes)) {
                saveState();
                graph.nodes = loadedData.nodes;
                graph.edges = Array.isArray(loadedData.edges) ? loadedData.edges : [];
                let maxId = 0;
                graph.nodes.forEach(n => { if (n.id > maxId) maxId = n.id; });
                nextId = maxId + 1;
                updateAllNodes(); selectedNodes = []; selectedPart = null;
                transformControls.detach(); renderProperties(null); sendDataToPythonCore();
                alert('📦 Модель успешно загружена!');
            } else {
                alert('⚠️ Ошибка: Неверный формат файла модели.');
            }
        } catch (err) {
            console.error(err);
            alert('❌ Не удалось прочитать JSON-файл.');
        }
        e.target.value = '';
    };
    reader.readAsText(file);
}

// ============================================================
// 11. ОТОБРАЖЕНИЕ СВОЙСТВ
// ============================================================
function renderProperties(id) {
    const container = document.getElementById('propContent');
    if (!container) return;
    if (selectedNodes.length === 0) { container.innerHTML = '<div class="empty">Выберите сфираль или элемент</div>'; return; }

    if (selectedNodes.length > 1) {
        if (selectedPart) selectedPart = null;
        const sampleNode = getNode(selectedNodes[0]);
        const currentGroupScale = sampleNode ? (sampleNode.params.scale ?? 1.0) : 1.0;
        const currentGroupStretch = sampleNode ? (sampleNode.params.stretch ?? 1.0) : 1.0;

        container.innerHTML = `
            <div class="prop-group highlight">📦 Группа: <b>${selectedNodes.length} шт.</b></div>
            <div class="prop-group"><label>Общий масштаб группы</label><input type="number" id="groupScale" value="${currentGroupScale}" min="0.1" max="10.0" step="0.1" /></div>
            <div class="prop-group"><label>Пружина / Растяжение Z</label><input type="number" id="groupStretch" value="${currentGroupStretch}" min="0.1" max="5.0" step="0.1" /></div>
        `;

        document.getElementById('groupScale').addEventListener('input', (e) => {
            const sc = parseFloat(e.target.value);
            if (!isNaN(sc)) { applyScaleAndStretchToNodes(selectedNodes, sc, undefined); }
        });

        document.getElementById('groupStretch').addEventListener('input', (e) => {
            const st = parseFloat(e.target.value);
            if (!isNaN(st)) { applyScaleAndStretchToNodes(selectedNodes, undefined, st); }
        });
        return;
    }

    const node = getNode(id);
    if (!node) { container.innerHTML = '<div class="empty">Выберите сфираль или элемент</div>'; return; }
    const p = node.params;

    if (selectedPart) {
        let subKey = 'rightSub';
        if (selectedPart === 'left') subKey = 'leftSub';
        else if (selectedPart === 's' || selectedPart === 'sRight') subKey = 'sRightSub';
        else if (selectedPart === 'sLeft') subKey = 'sLeftSub';

        if (!node.params[subKey]) node.params[subKey] = { height: 100 };
        const sub = node.params[subKey];

        container.innerHTML = `
            <div class="prop-group highlight">🎯 Подобъект: ${selectedPart}</div>
            <div class="prop-group"><label>Сжатие по высоте (%)</label><input type="number" id="subHeight" value="${sub.height}" min="10" max="500" step="5" /></div>
        `;

        document.getElementById('subHeight').addEventListener('input', () => {
            const h = parseFloat(document.getElementById('subHeight').value);
            if (!isNaN(h)) sub.height = h;
            updateNodeVisual(node); updateEdges();
        });
        return;
    }

    const activeGate = p.activeGate || 'H';
    container.innerHTML = `
        <div class="prop-group highlight">📦 Сфираль [ID: ${node.id}]</div>
        <div class="prop-group">
            <label>Квантовый вентиль (КудИТ)</label>
            <select id="nodeGateSelect" style="width:100%; background:#1f2d4a; color:#fff; padding:4px; border-radius:4px; font-size:0.75rem;">
                <option value="H" ${activeGate === 'H' ? 'selected' : ''}>H (Адамар / Супериор)</option>
                <option value="S_TRANSITION" ${activeGate === 'S_TRANSITION' ? 'selected' : ''}>S_TRANSITION (Топологический S-переход)</option>
                <option value="X" ${activeGate === 'X' ? 'selected' : ''}>X (Инверсия витков)</option>
            </select>
        </div>
        <div class="prop-group"><label>Общий масштаб (+ / -)</label><input type="number" id="propScale" value="${p.scale ?? 1.0}" min="0.1" max="10.0" step="0.1" /></div>
        <div class="prop-group"><label>Пружина / Растяжение Z (] / [)</label><input type="number" id="propStretch" value="${p.stretch ?? 1.0}" min="0.1" max="5.0" step="0.1" /></div>
    `;

    document.getElementById('nodeGateSelect')?.addEventListener('change', (e) => {
        node.params.activeGate = e.target.value;
        saveState();
        updateNodeVisual(node);
        sendDataToPythonCore();
    });

    document.getElementById('propScale').addEventListener('input', (e) => {
        const sc = parseFloat(e.target.value);
        if (!isNaN(sc)) { applyScaleAndStretchToNodes([node.id], sc, undefined); }
    });

    document.getElementById('propStretch').addEventListener('input', (e) => {
        const st = parseFloat(e.target.value);
        if (!isNaN(st)) { applyScaleAndStretchToNodes([node.id], undefined, st); }
    });
}

// ============================================================
// 12. ИНИЦИАЛИЗАЦИЯ
// ============================================================
function init() {
    new UIManager();
    // Сцена теперь запускается абсолютно пустой без автосоздания первой сфирали
    updateEdges();
    updateStats();
    resizeRenderer();
    saveState();
    animate();
}

init();