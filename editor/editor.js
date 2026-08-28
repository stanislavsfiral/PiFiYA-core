import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/jsm/controls/TransformControls.js';
import { generateRightBranch, TernarySpatialWalshEngine } from './FractalBuilder.js';
import { computeQuantumNetwork } from '../core/GideonMath.js';

// ============================================================
// 1. СОСТОЯНИЕ ПРИЛОЖЕНИЯ И ЛОГИРОВАНИЕ ИСТОРИИ ДЕЙСТВИЙ (AI TRAINING)
// ============================================================
let graph = { nodes: [], edges: [] };
let nextId = 1;
let selectedNodes = [];
let selectedPart = null;
let undoStack = [], redoStack = [];
const MAX_UNDO = 30;
let clipboard = null;
let pythonTimeout = null;

// Состояние режима ручной трассировки портов
let isWiringMode = false;
let wiringSource = null;
let interactivePorts = [];

let designTimeline = [];

function logAction(actionType, payload) {
    const stepRecord = {
        step: designTimeline.length + 1,
        timestamp: Date.now(),
        action: actionType,
        data: payload
    };
    designTimeline.push(stepRecord);
    console.log(`🧠 [AI Timeline Log]: ${actionType}`, payload);
}

const groupTransformProxy = new THREE.Group();
groupTransformProxy.name = "GIDEON_Group_Proxy";

const batchLines = {
    right: new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff3333, linewidth: 3, transparent: true, opacity: 1.0 })),
    left: new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x00c0ff, linewidth: 3, transparent: true, opacity: 1.0 })),
    s: new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffea00, linewidth: 3, transparent: true, opacity: 1.0 }))
};

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
// 2. ЯДРО – РАБОТА С ГРАФОМ И СЕТЬЮ
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
            activeGate: params?.activeGate || 'ROUTER_SWAP',
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
    logAction('ADD_NODE', { id: node.id, x: node.x, y: node.y, z: node.z, params: node.params });
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
    logAction('CONNECT_NODES', { from: fromId, to: toId, type });
    return edge;
}

function removeNode(id) {
    graph.nodes = graph.nodes.filter(n => n.id !== id);
    graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);
    logAction('REMOVE_NODE', { id });
}

function getNode(id) { return graph.nodes.find(n => n.id === id); }

function autoConnectStuckNodes() {
    if (graph.nodes.length > 50) return;
}

function compileTopologyToQuantumCircuit() {
    let circuitGates = [];
    graph.nodes.forEach(node => {
        const gate = node.params.activeGate || 'ROUTER_SWAP';
        circuitGates.push(`${gate}(q${node.id})`);
    });
    graph.edges.forEach(edge => {
        circuitGates.push(`LINK(q${edge.from}, q${edge.to})`);
    });

    const consoleEl = document.getElementById('console');
    if (consoleEl && graph.nodes.length > 0) {
        consoleEl.style.display = 'block';
        consoleEl.innerHTML += `
            <div class="line success">🧬 [Авто-Компилятор схемы]: Сгенерирован топологический пайплайн</div>
            <div class="line">🛠️ [Активные вентили]: ${circuitGates.join(' — ')}</div>
        `;
    }
}

function updateQuantumColors(nodesQuantum) {
    if (!nodesQuantum || !Array.isArray(nodesQuantum)) return;

    nodesQuantum.forEach(qData => {
        const nodeId = qData.id;
        const state = qData.qutrit_state;
        if (!state) return;

        const L = state.L || 0;
        const S = state.S || 0;
        const R = state.R || 0;

        let colorHex = 0xffaa00; 
        const threshold = 0.5;

        if (R > threshold) {
            colorHex = 0xff3333; 
        } else if (L > threshold) {
            colorHex = 0x00c0ff; 
        } else if (S > threshold) {
            colorHex = 0xffea00; 
        } else {
            colorHex = 0x00ffaa; 
        }

        const group = meshMap.get(nodeId);
        if (group) {
            group.children.forEach(child => {
                if (child.userData && child.userData.part === 'center') {
                    child.material.color.setHex(colorHex);
                    
                    if (colorHex === 0x00ffaa) {
                        child.material.opacity = 1.0;
                        child.scale.set(1.2, 1.2, 1.2);
                    } else {
                        child.material.opacity = 0.85;
                        child.scale.set(1.0, 1.0, 1.0);
                    }
                }
            });
        }
    });
}

// ============================================================
// 3. АВТОНОМНЫЙ КВАНТОВЫЙ РАСЧЕТ (БЕЗ PYTHON-БЭКЕНДА)
// ============================================================
async function sendDataToPythonCore(isSaving = true) {
    const startTime = performance.now();
    try {
        const nodesQuantum = computeQuantumNetwork(graph.nodes, graph.edges);
        const executionTime = (performance.now() - startTime).toFixed(2);
        
        const consoleEl = document.getElementById('console');
        if (consoleEl) {
            consoleEl.style.display = 'block';
            consoleEl.innerHTML += `<div class="line success">⚡ [Native Q-Core]: Узлов: ${graph.nodes.length}, Время расчета: ${executionTime}мс</div>`;
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }
        
        updateQuantumColors(nodesQuantum);
        compileTopologyToQuantumCircuit();
    } catch (err) {
        console.error("Ошибка автономного расчета:", err);
    }
}

const sendDataPythonCoreThrottled = () => {
    if (pythonTimeout) clearTimeout(pythonTimeout);
    pythonTimeout = setTimeout(() => sendDataToPythonCore(true), 400);
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

const wiringPortMeshes = new THREE.Group();
scene.add(wiringPortMeshes);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 5000);
camera.position.set(600, 400, 800);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);
controls.screenSpacePanning = true;
controls.update();

// UX UPDATE: Левая кнопка вращает камеру
controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN
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
                    if (!node.params) node.params = {};
                    if (!node.params.angles) node.params.angles = [0, 0, 0];
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
                if (!node.params) node.params = {};
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
    updateWiringPorts(); 
});

transformControls.addEventListener('mouseUp', () => {
    autoConnectStuckNodes();
    saveState();
    updateStats();
    if (selectedNodes.length === 1) {
        const node = getNode(selectedNodes[0]);
        if (node) {
            logAction('TRANSFORM_NODE', { id: node.id, x: node.x, y: node.y, z: node.z, angles: node.params?.angles || [0,0,0] });
        }
    } else if (selectedNodes.length > 1) {
        logAction('TRANSFORM_GROUP', { nodes: selectedNodes });
    }
    sendDataToPythonCore(true);
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
    if (!node.params) {
        node.params = { scale: 1.0, stretch: 1.0, N: 5, angles: [0,0,0], showRight: true, showS: true, showLeft: true, showSLeft: true };
    }
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
    updateWiringPorts();
}

function updateWiringPorts() {
    wiringPortMeshes.clear();
    interactivePorts = [];
    if (!isWiringMode) return;

    graph.nodes.forEach(node => {
        const group = meshMap.get(node.id);
        if (!group) return;

        const p = node.params || {};
        const N = p.N || 5, sc = p.scale ?? 1.0, st = p.stretch ?? 1.0;
        const geom = getCachedSfiralGeometries(N, sc, st, p, p.showRight ?? true, p.showLeft ?? true);

        const offsetIdx = 6; 
        const markerRadius = 4 * sc;

        if (p.showRight !== false && geom.rightPts && geom.rightPts.length > offsetIdx) {
            const entryPos = geom.rightPts[offsetIdx].clone().applyEuler(group.rotation).add(group.position);
            const entryMesh = new THREE.Mesh(new THREE.SphereGeometry(markerRadius, 16, 16), new THREE.MeshBasicMaterial({color: 0x00ffaa, transparent: true, opacity: 0.9}));
            entryMesh.position.copy(entryPos);
            wiringPortMeshes.add(entryMesh);
            interactivePorts.push({ mesh: entryMesh, nodeId: node.id, type: 'entry' });
        } else if (p.showRight === false && p.showS !== false && geom.sRightPts && geom.sRightPts.length > offsetIdx) {
            const entryPos = geom.sRightPts[offsetIdx].clone().applyEuler(group.rotation).add(group.position);
            const entryMesh = new THREE.Mesh(new THREE.SphereGeometry(markerRadius, 16, 16), new THREE.MeshBasicMaterial({color: 0xffea00, transparent: true, opacity: 0.9}));
            entryMesh.position.copy(entryPos);
            wiringPortMeshes.add(entryMesh);
            interactivePorts.push({ mesh: entryMesh, nodeId: node.id, type: 'entry' });
        }
        
        if (p.showLeft !== false && geom.leftPts && geom.leftPts.length > offsetIdx) {
            const exitPos = geom.leftPts[offsetIdx].clone().applyEuler(group.rotation).add(group.position);
            const exitMesh = new THREE.Mesh(new THREE.SphereGeometry(markerRadius, 16, 16), new THREE.MeshBasicMaterial({color: 0xff0044, transparent: true, opacity: 0.9}));
            exitMesh.position.copy(exitPos);
            wiringPortMeshes.add(exitMesh);
            interactivePorts.push({ mesh: exitMesh, nodeId: node.id, type: 'exit' });
        } else if (p.showLeft === false && p.showSLeft !== false && geom.sLeftPts && geom.sLeftPts.length > offsetIdx) {
            const exitPos = geom.sLeftPts[offsetIdx].clone().applyEuler(group.rotation).add(group.position);
            const exitMesh = new THREE.Mesh(new THREE.SphereGeometry(markerRadius, 16, 16), new THREE.MeshBasicMaterial({color: 0xff8800, transparent: true, opacity: 0.9}));
            exitMesh.position.copy(exitPos);
            wiringPortMeshes.add(exitMesh);
            interactivePorts.push({ mesh: exitMesh, nodeId: node.id, type: 'exit' });
        }
    });
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

        const p1 = fromNode.params || {};
        const p2 = toNode.params || {};
        const N1 = p1.N || 5, sc1 = p1.scale ?? 1.0, st1 = p1.stretch ?? 1.0;
        const geom1 = getCachedSfiralGeometries(N1, sc1, st1, p1, p1.showRight ?? true, p1.showLeft ?? true);
        
        const N2 = p2.N || 5, sc2 = p2.scale ?? 1.0, st2 = p2.stretch ?? 1.0;
        const geom2 = getCachedSfiralGeometries(N2, sc2, st2, p2, p2.showRight ?? true, p2.showLeft ?? true);

        const r1_free = geom1.rightPts[0].clone().applyEuler(fromGroup.rotation).add(fromGroup.position);
        const l1_free = geom1.leftPts[0].clone().applyEuler(fromGroup.rotation).add(fromGroup.position);

        const r2_free = geom2.rightPts[0].clone().applyEuler(toGroup.rotation).add(toGroup.position);
        const l2_free = geom2.leftPts[0].clone().applyEuler(toGroup.rotation).add(toGroup.position);

        if (edge.type === 'manual_wire') {
            const geo = new THREE.BufferGeometry().setFromPoints([l1_free, r2_free]);
            const mat = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 4, transparent: true, opacity: 0.9 });
            const line = new THREE.Line(geo, mat);
            objectsGroup.add(line);
            chronoBridgeLines.push(line);
            return; 
        }

        const rot1 = p1.angles || [0, 0, 0];
        const rot2 = p2.angles || [0, 0, 0];
        const diffY = Math.abs((rot2[1] - rot1[1]) % 360);
        const diffZ = Math.abs((rot2[2] - rot1[2]) % 360);

        const isFlipped180 = (Math.abs(diffY - 180) < 5 || Math.abs(diffY - 540) < 5) && 
                             (Math.abs(diffZ - 180) < 5 || Math.abs(diffZ - 540) < 5);

        const isNotFlipped = (diffY < 5 || Math.abs(diffY - 360) < 5) && 
                             (diffZ < 5 || Math.abs(diffZ - 360) < 5);

        if (isFlipped180) {
            if ((p1.showRight ?? true) && (p2.showRight ?? true)) {
                const distR = r1_free.distanceTo(r2_free);
                if (distR < MAX_CONNECTION_DIST) {
                    points.right.push(r1_free, r2_free);
                }
            }
            if ((p1.showLeft ?? true) && (p2.showLeft ?? true)) {
                const distL = l1_free.distanceTo(l2_free);
                if (distL < MAX_CONNECTION_DIST) {
                    points.left.push(l1_free, l2_free);
                }
            }
        } else if (isNotFlipped) {
            if ((p1.showRight ?? true) && (p2.showLeft ?? true)) {
                const distRL = r1_free.distanceTo(l2_free);
                if (distRL < MAX_CONNECTION_DIST) {
                    points.right.push(r1_free, l2_free);
                }
            }
            if ((p1.showLeft ?? true) && (p2.showRight ?? true)) {
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

            const p1 = n1.params || {};
            const p2 = n2.params || {};
            const N1 = p1.N || 5, sc1 = p1.scale ?? 1.0, st1 = p1.stretch ?? 1.0;
            const geom1 = getCachedSfiralGeometries(N1, sc1, st1, p1, p1.showRight ?? true, p1.showLeft ?? true);
            
            const N2 = p2.N || 5, sc2 = p2.scale ?? 1.0, st2 = p2.stretch ?? 1.0;
            const geom2 = getCachedSfiralGeometries(N2, sc2, st2, p2, p2.showRight ?? true, p2.showLeft ?? true);

            const rot1 = p1.angles || [0, 0, 0];
            const rot2 = p2.angles || [0, 0, 0];
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
                if ((p1.showRight ?? true) && (p2.showRight ?? true)) {
                    checkPointsPairs.push({ p1: r1_free, p2: r2_free, color: 0xff3333 });
                }
                if ((p1.showLeft ?? true) && (p2.showLeft ?? true)) {
                    checkPointsPairs.push({ p1: l1_free, p2: l2_free, color: 0x00c0ff });
                }
            } else if (isNotFlipped) {
                if ((p1.showRight ?? true) && (p2.showLeft ?? true)) {
                    checkPointsPairs.push({ p1: r1_free, p2: l2_free, color: 0xff3333 });
                }
                if ((p1.showLeft ?? true) && (p2.showRight ?? true)) {
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

function updateStats() {
    const nodeCountEl = document.getElementById('nodeCount');
    const edgeCountEl = document.getElementById('edgeCount');
    const paramCountEl = document.getElementById('paramCount');
    if (!nodeCountEl || !edgeCountEl || !paramCountEl) return;

    nodeCountEl.textContent = `Сфиралей: ${graph.nodes.length}`;
    let totalEdges = graph.edges.length;
    let leftCount = graph.edges.filter(e => e.type === 'left_polarization').length;
    let rightCount = graph.edges.filter(e => e.type === 'right_polarization').length;
    let sLoopCount = graph.edges.filter(e => e.type === 's_loop').length;
    
    graph.nodes.forEach(n => {
        const p = n.params || {};
        if (p.showS !== false) sLoopCount++;
        if (p.showSLeft !== false) sLoopCount++;
    });

    edgeCountEl.textContent = `Хроноквантов: ${totalEdges + graph.nodes.length * 2} (L:${leftCount} | R:${rightCount} | S:${sLoopCount})`;
    let totalParams = 0;
    graph.nodes.forEach(n => { totalParams += 20; });
    totalParams += totalEdges * 2;
    paramCountEl.textContent = `Параметров: ${totalParams}`;
}

// ============================================================
// 6. ВЫДЕЛЕНИЕ И ТРАНСФОРМАЦИЯ И АВТОВЫРАВНИВАНИЕ (СНАППИНГ)
// ============================================================
function snapSelectedObjects(tolerance = 3.0) {
    const targetIds = (selectedNodes && selectedNodes.length > 0) ? selectedNodes : graph.nodes.map(n => n.id);
    if (targetIds.length === 0) return;

    saveState();
    let count = 0;

    targetIds.forEach(id => {
        const node = getNode(id);
        const group = meshMap.get(id);
        if (!node || !group) return;

        if (node.params && node.params.angles) {
            node.params.angles = node.params.angles.map(currentDeg => {
                let targetDeg = Math.round(currentDeg / 90) * 90;
                if (Math.abs(currentDeg - targetDeg) <= tolerance) {
                    count++;
                    return targetDeg;
                }
                return currentDeg;
            });

            group.rotation.set(
                THREE.MathUtils.degToRad(node.params.angles[0]),
                THREE.MathUtils.degToRad(node.params.angles[1]),
                THREE.MathUtils.degToRad(node.params.angles[2])
            );
        }

        ['x', 'y', 'z'].forEach(axis => {
            let currentPos = node[axis];
            let targetPos = Math.round(currentPos);
            
            if (Math.abs(currentPos - targetPos) <= tolerance) {
                node[axis] = targetPos;
                count++;
            }
        });

        updateNodeVisual(node);
    });

    updateEdges();
    updateStats();
    updateWiringPorts();
    logAction('SNAP_ALL_OR_SELECTED', { targets: targetIds, tolerance, adjustedCount: count });
    sendDataToPythonCore(true);
}
window.snapSelectedObjects = snapSelectedObjects;

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
    logAction('CENTER_SELECTED', { nodes: selectedNodes });
    sendDataToPythonCore(true);
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
                ...(n.params || {}),
                angles: n.params?.angles ? [...n.params.angles] : [0,0,0],
                rightSub: n.params?.rightSub ? { ...n.params.rightSub } : { height: 100 },
                leftSub: n.params?.leftSub ? { ...n.params.leftSub } : { height: 100 },
                sRightSub: n.params?.sRightSub ? { ...n.params.sRightSub } : { height: 100 },
                sLeftSub: n.params?.sLeftSub ? { ...n.params.sLeftSub } : { height: 100 }
            }
        })),
        edges: graph.edges.map(e => ({ ...e }))
    };
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
}

function copySelected() {
    if (selectedNodes.length === 0) return;
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
    if (!clipboard || clipboard.nodes.length === 0) return;
    saveState();
    const idMap = {};
    const newIds = [];

    clipboard.nodes.forEach(src => {
        const p = src.params || {};
        const newNode = addNode(src.mode, src.x, src.y, src.z, {
            N: p.N,
            target_len: p.target_len,
            scale: p.scale,
            stretch: p.stretch,
            angles: p.angles ? [...p.angles] : [0,0,0],
            activeGate: p.activeGate,
            showRight: p.showRight,
            showS: p.showS,
            showLeft: p.showLeft,
            showSLeft: p.showSLeft,
            rightSub: p.rightSub ? { ...p.rightSub } : undefined,
            leftSub: p.leftSub ? { ...p.leftSub } : undefined,
            sRightSub: p.sRightSub ? { ...p.sRightSub } : undefined,
            sLeftSub: p.sLeftSub ? { ...p.sLeftSub } : undefined
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

    updateEdges(); updateStats();
    selectedNodes = newIds; selectedPart = null;
    updateSelectionHighlights(); renderProperties(selectedNodes.length === 1 ? selectedNodes[0] : null);
    logAction('PASTE_CLIPBOARD', { newIds }); sendDataToPythonCore(true);
}

function applyScaleAndStretchToNodes(nodeIds, newScale, newStretch) {
    saveState();
    const targetNodes = nodeIds.map(nid => getNode(nid)).filter(Boolean);
    if (targetNodes.length === 0) return;

    let cx = 0, cy = 0, cz = 0;
    targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
    cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

    const sampleNode = targetNodes[0];
    const oldScale = sampleNode.params?.scale ?? 1.0;
    const oldStretch = sampleNode.params?.stretch ?? 1.0;

    targetNodes.forEach(node => {
        if (!node.params) node.params = {};
        
        if (nodeIds.length > 1) {
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
        } else {
            if (newScale !== undefined) node.params.scale = newScale;
            if (newStretch !== undefined) node.params.stretch = newStretch;
        }

        updateNodeVisual(node);
    });

    updateEdges(); logAction('SCALE_STRETCH', { nodeIds, newScale, newStretch }); sendDataPythonCoreThrottled();
}

// ============================================================
// 9. UI-МЕНЕДЖЕР И КОРРЕКТНЫЕ УПРАВЛЯЮЩИЕ ВЕНТИЛИ
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
        const snapBtn = document.getElementById('snapObjectsBtn');

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

        if (centerBtn) centerBtn.addEventListener('click', () => { centerSelectedToOrigin(); });
        if (snapBtn) snapBtn.addEventListener('click', () => { snapSelectedObjects(3.0); });
    }

    setupQuantumGates() {
        document.getElementById('gateRouter')?.addEventListener('click', () => {
            if (selectedNodes.length === 0) return;
            saveState();
            selectedNodes.forEach(id => {
                const node = getNode(id);
                if (node) {
                    if (!node.params) node.params = {};
                    node.params.activeGate = 'ROUTER_SWAP';
                    const temp = node.params.showRight;
                    node.params.showRight = node.params.showLeft;
                    node.params.showLeft = temp;
                    updateNodeVisual(node);
                }
            });
            updateEdges(); updateStats(); sendDataToPythonCore(true);
        });

        document.getElementById('gateReadout')?.addEventListener('click', () => {
            if (selectedNodes.length === 0) return;
            saveState();
            selectedNodes.forEach(id => {
                const node = getNode(id);
                if (node) { 
                    if (!node.params) node.params = {};
                    node.params.activeGate = 'READOUT'; 
                    node.quantumState.intensity = 1.0; 
                    updateNodeVisual(node); 
                }
            });
            updateEdges(); updateStats(); sendDataToPythonCore(true);
        });

        document.getElementById('gateScaleControl')?.addEventListener('click', (e) => {
            if (selectedNodes.length === 0) return;
            saveState();
            
            const step = e.shiftKey ? -0.2 : 0.2;

            if (selectedNodes.length === 1) {
                const node = getNode(selectedNodes[0]);
                if (node) {
                    if (!node.params) node.params = {};
                    node.params.activeGate = 'SCALE_CORRECTOR';
                    const currentStretch = node.params.stretch !== undefined ? node.params.stretch : 1.0;
                    node.params.stretch = Math.max(0.1, Math.min(5.0, Number((currentStretch + step).toFixed(1))));
                    updateNodeVisual(node);
                }
            } else {
                const sampleNode = getNode(selectedNodes[0]);
                const currentStretch = sampleNode?.params?.stretch !== undefined ? sampleNode.params.stretch : 1.0;
                const newStretch = Math.max(0.1, Math.min(5.0, Number((currentStretch + step).toFixed(1))));
                applyScaleAndStretchToNodes(selectedNodes, undefined, newStretch);
            }

            updateEdges(); updateStats(); sendDataToPythonCore(true);
        });

        document.getElementById('gateReset')?.addEventListener('click', () => {
            if (selectedNodes.length === 0) return;
            saveState();
            selectedNodes.forEach(id => {
                const node = getNode(id);
                if (node) {
                    if (!node.params) node.params = {};
                    node.params.activeGate = 'RESET';
                    node.params.showRight = true; node.params.showLeft = true;
                    node.params.stretch = 1.0; node.quantumState.intensity = 0;
                    updateNodeVisual(node);
                }
            });
            updateEdges(); updateStats(); sendDataToPythonCore(true);
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

    toggleWiringMode() {
        isWiringMode = !isWiringMode;
        const btn = document.getElementById('connectBtn');
        const consoleEl = document.getElementById('console');
        if (isWiringMode) {
            btn.style.background = '#00ffaa';
            btn.style.color = '#000';
            btn.innerText = '🔌 Трассировка';
            selectedNodes = [];
            transformControls.detach();
            updateSelectionHighlights();
            if (consoleEl) {
                consoleEl.style.display = 'block';
                consoleEl.innerHTML += `<div class="line" style="color:#00ffaa">🔌 [ТРАССИРОВКА ВКЛЮЧЕНА] Кликните на Красный ВЫХОД, затем на Зеленый ВХОД.</div>`;
            }
        } else {
            btn.style.background = '';
            btn.style.color = '';
            btn.innerText = '🔗';
            wiringSource = null;
            if (consoleEl) {
                consoleEl.innerHTML += `<div class="line" style="color:#ffaa00">🔌 [ТРАССИРОВКА ОТКЛЮЧЕНА]</div>`;
            }
        }
        updateWiringPorts();
        if (consoleEl) consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    setupEventListeners() {
        document.getElementById('closeMoveModalX')?.addEventListener('click', () => { document.getElementById('moveDialogModal').style.display = 'none'; });
        document.getElementById('closeRotModalX')?.addEventListener('click', () => { document.getElementById('rotateDialogModal').style.display = 'none'; });

        ['modalPosX', 'modalPosY', 'modalPosZ'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.addEventListener('input', () => { applyModalPositionLive(); autoConnectStuckNodes(); }); el.addEventListener('change', () => { saveState(); sendDataToPythonCore(true); }); }
        });

        ['modalRotX', 'modalRotY', 'modalRotZ'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.addEventListener('input', () => { applyModalRotationLive(); autoConnectStuckNodes(); }); el.addEventListener('change', () => { saveState(); sendDataToPythonCore(true); }); }
        });

        document.getElementById('addNodeBtn')?.addEventListener('click', addNodeHandler);
        document.getElementById('deleteBtn')?.addEventListener('click', deleteSelected);
        
        document.getElementById('connectBtn')?.addEventListener('click', (e) => {
            if (document.getElementById('tutorialModal').style.display !== 'none') {
                if (selectedNodes.length === 2) {
                    saveState();
                    addEdge(selectedNodes[0], selectedNodes[1], 1.0, 'right_polarization');
                    updateEdges(); updateStats(); sendDataToPythonCore(true);
                }
                return;
            }
            this.toggleWiringMode();
        });

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

        const selectionRect = document.getElementById('selectionRect');
        let mouseDownPos = { x: 0, y: 0 };
        let mouseDownObjectId = null;
        let mouseDownPart = null;
        let isBoxSelecting = false;
        let boxStart = { x: 0, y: 0 };

        renderer.domElement.addEventListener('pointerdown', (e) => {
            if (isWiringMode && e.button === 0) {
                const rect = container.getBoundingClientRect();
                const mouse = new THREE.Vector2();
                mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
                mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
                const raycaster = new THREE.Raycaster();
                raycaster.setFromCamera(mouse, camera);

                const intersects = raycaster.intersectObjects(interactivePorts.map(p => p.mesh));
                if (intersects.length > 0) {
                    const hitMesh = intersects[0].object;
                    const hit = interactivePorts.find(p => p.mesh === hitMesh);
                    const consoleEl = document.getElementById('console');
                    
                    if (hit.type === 'exit') {
                        wiringSource = hit;
                        interactivePorts.forEach(p => { if (p.type === 'exit') p.mesh.material.color.setHex(0xff0044); });
                        hitMesh.material.color.setHex(0xffffff); 
                        if (consoleEl) {
                            consoleEl.innerHTML += `<div class="line">🔌 [Трассировка]: Выбран выход сфирали ID:${hit.nodeId}. Укажите зеленый вход.</div>`;
                            consoleEl.scrollTop = consoleEl.scrollHeight;
                        }
                    } else if (hit.type === 'entry' && wiringSource) {
                        saveState();
                        addEdge(wiringSource.nodeId, hit.nodeId, 1.0, 'manual_wire');
                        wiringSource = null;
                        updateEdges();
                        updateWiringPorts();
                        sendDataToPythonCore(true);
                        if (consoleEl) {
                            consoleEl.innerHTML += `<div class="line success">🔗 [Трассировка]: Спаяно! Связь установлена.</div>`;
                            consoleEl.scrollTop = consoleEl.scrollHeight;
                        }
                    }
                }
                return; 
            }

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
            if (isWiringMode) return; 

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
                    let targetScale = sampleNode.params?.scale ?? 1.0;
                    let targetStretch = sampleNode.params?.stretch ?? 1.0;
                    let changed = false;

                    if (key === '=' || key === '+') { targetScale = Math.min(10.0, targetScale + 0.1); changed = true; }
                    else if (key === '-' || key === '_') { targetScale = Math.max(0.1, targetScale - 0.1); changed = true; }
                    else if (key === ']') { targetStretch = Math.min(5.0, targetStretch + 0.1); changed = true; }
                    else if (key === '[') { targetStretch = Math.max(0.1, targetStretch - 0.1); changed = true; }

                    if (changed) {
                        e.preventDefault();
                        applyScaleAndStretchToNodes(
                            selectedNodes,
                            targetScale !== (sampleNode.params?.scale ?? 1.0) ? targetScale : undefined,
                            targetStretch !== (sampleNode.params?.stretch ?? 1.0) ? targetStretch : undefined
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
                if(isWiringMode) this.toggleWiringMode(); 
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
        if (!node.params) node.params = {};
        if (!node.params.angles) node.params.angles = [0,0,0];
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
        const curRot = firstNode.params?.angles || [0, 0, 0];
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
            v.add(new THREE.Vector3(cx, cy, cy)); // Keep Y logic simple
            node.x = v.x; node.y = v.y; node.z = v.z;

            group.rotation.setFromQuaternion(group.quaternion.premultiply(quatDelta));
            if (!node.params) node.params = {};
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
        if (node && node.params && node.params.angles) {
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
    const node = addNode('Single', nextX, 0, nextZ, { N: 5, target_len: 1000, scale: 1.0, stretch: 1.0, angles: [0, 0, 0], activeGate: 'ROUTER_SWAP' });
    updateNodeVisual(node); updateEdges(); updateStats(); updateWiringPorts();
    selectedNodes = [node.id]; selectedPart = null;
    updateSelectionHighlights(); renderProperties(node.id); sendDataToPythonCore(true);
}

function deleteSelected() {
    if (selectedNodes.length === 0) return alert('Выберите сфирали');
    saveState();

    if (selectedPart && selectedNodes.length === 1) {
        const node = getNode(selectedNodes[0]);
        if (node) {
            if (!node.params) node.params = {};
            if (selectedPart === 'right') node.params.showRight = false;
            else if (selectedPart === 's' || selectedPart === 'sRight') node.params.showS = false;
            else if (selectedPart === 'left') node.params.showLeft = false;
            else if (selectedPart === 'sLeft') node.params.showSLeft = false;

            updateNodeVisual(node); selectedPart = null;
            updateSelectionHighlights(); renderProperties(node.id); 
            logAction('HIDE_PART', { id: node.id, part: selectedPart });
            sendDataToPythonCore(true);
            return;
        }
    }

    selectedNodes.forEach(id => {
        removeNode(id);
        if (meshMap.has(id)) { objectsGroup.remove(meshMap.get(id)); meshMap.delete(id); }
    });
    selectedNodes = []; selectedPart = null; transformControls.detach();
    updateEdges(); updateStats(); updateWiringPorts(); renderProperties(null);
    updateSelectionHighlights(); sendDataToPythonCore(true);
}

function buildFractalComposition() {
    saveState();
    graph.nodes = []; graph.edges = []; nextId = 1;
    const n1 = addNode('Single', 0, 0, 0, { N: 5, target_len: 1000, scale: 1.0, stretch: 1.0, angles: [0, 0, 0], activeGate: 'ROUTER_SWAP' });
    const n2 = addNode('Single', -140, 0, -180, { N: 5, target_len: 1000, scale: 1.0, stretch: 1.0, angles: [0, 0, 0], activeGate: 'ROUTER_SWAP' });
    addEdge(n1.id, n2.id, 1.0, 'right_polarization');
    updateAllNodes(); selectedNodes = [n1.id]; selectedPart = null;
    updateSelectionHighlights(); renderProperties(n1.id); 
    logAction('BUILD_PRESET', { preset: 'fractal_composition' });
    sendDataToPythonCore(true);
}

async function saveModel() {
    console.log("💾 Сохранение модели и принудительный бэкап в ai_memory...");
    await sendDataToPythonCore(true);

    const exportData = {
        graph: graph,
        design_timeline: designTimeline
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "gideon_sfiral_model_with_history.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    
    alert('🧠 Сессия зафиксирована в ai_memory и скачана на компьютер!');
}

function loadModel(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            const loadedData = JSON.parse(event.target.result);
            
            let nodesArray = [];
            let edgesArray = [];
            let timelineArray = [];

            if (Array.isArray(loadedData)) {
                nodesArray = loadedData.map((item, idx) => ({
                    id: item.id || (idx + 1),
                    mode: item.mode || 'Single',
                    x: item.x || 0,
                    y: item.y || 0,
                    z: item.z || 0,
                    params: {
                        N: 5,
                        target_len: 1000,
                        scale: item.scale || 1.0,
                        stretch: item.stretch || 1.0,
                        angles: item.angles || [0, 0, 0],
                        activeGate: 'ROUTER_SWAP',
                        showRight: true, showS: true, showLeft: true, showSLeft: true,
                        rightSub: { height: 100 }, leftSub: { height: 100 },
                        sRightSub: { height: 100 }, sLeftSub: { height: 100 }
                    },
                    quantumState: { intensity: 0, psi_real: 0, psi_imag: 0 }
                }));
            } else if (loadedData.graph && Array.isArray(loadedData.graph.nodes)) {
                nodesArray = loadedData.graph.nodes;
                edgesArray = loadedData.graph.edges || [];
                timelineArray = loadedData.design_timeline || [];
            } else if (Array.isArray(loadedData.nodes)) {
                nodesArray = loadedData.nodes;
                edgesArray = loadedData.edges || [];
                timelineArray = loadedData.design_timeline || [];
            }

            if (nodesArray.length > 0) {
                saveState();
                graph.nodes = nodesArray.map(n => ({
                    ...n,
                    params: {
                        N: n.params?.N || 5,
                        target_len: n.params?.target_len || 1000,
                        scale: n.params?.scale ?? 1.0,
                        stretch: n.params?.stretch ?? 1.0,
                        angles: n.params?.angles ? [...n.params.angles] : [0, 0, 0],
                        activeGate: n.params?.activeGate || 'ROUTER_SWAP',
                        showRight: n.params?.showRight !== undefined ? n.params.showRight : true,
                        showS: n.params?.showS !== undefined ? n.params.showS : true,
                        showLeft: n.params?.showLeft !== undefined ? n.params.showLeft : true,
                        showSLeft: n.params?.showSLeft !== undefined ? n.params.showSLeft : true,
                        rightSub: n.params?.rightSub ? { ...n.params.rightSub } : { height: 100 },
                        leftSub: n.params?.leftSub ? { ...n.params.leftSub } : { height: 100 },
                        sRightSub: n.params?.sRightSub ? { ...n.params.sRightSub } : { height: 100 },
                        sLeftSub: n.params?.sLeftSub ? { ...n.params.sLeftSub } : { height: 100 }
                    }
                }));
                graph.edges = edgesArray;
                if (timelineArray.length > 0) {
                    designTimeline = timelineArray;
                }

                let maxId = 0;
                graph.nodes.forEach(n => { if (n.id > maxId) maxId = n.id; });
                nextId = maxId + 1;

                updateAllNodes(); 
                selectedNodes = []; 
                selectedPart = null;
                transformControls.detach(); 
                renderProperties(null); 
                sendDataToPythonCore(true);
                alert('📦 Модель успешно загружена!');
            } else {
                alert('⚠️ Ошибка: В файле не найдено валидных узлов Сфирали.');
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
        const currentGroupScale = sampleNode?.params?.scale ?? 1.0;
        const currentGroupStretch = sampleNode?.params?.stretch ?? 1.0;

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
    if (!node.params) node.params = {};
    const p = node.params;

    if (selectedPart) {
        let subKey = 'rightSub';
        if (selectedPart === 'left') subKey = 'leftSub';
        else if (selectedPart === 's' || selectedPart === 'sRight') subKey = 'subRight';
        else if (selectedPart === 'sLeft') subKey = 'subLeftSub';

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

    const activeGate = p.activeGate || 'ROUTER_SWAP';
    container.innerHTML = `
        <div class="prop-group highlight">📦 Сфираль [ID: ${node.id}]</div>
        <div class="prop-group">
            <label>Управляющий вентиль</label>
            <select id="nodeGateSelect" style="width:100%; background:#1f2d4a; color:#fff; padding:4px; border-radius:4px; font-size:0.75rem;">
                <option value="ROUTER_SWAP" ${activeGate === 'ROUTER_SWAP' ? 'selected' : ''}>Маршрутизатор (SWAP потоков)</option>
                <option value="READOUT" ${activeGate === 'READOUT' ? 'selected' : ''}>Датчик считывания (Readout)</option>
                <option value="SCALE_CORRECTOR" ${activeGate === 'SCALE_CORRECTOR' ? 'selected' : ''}>Корректор масштаба</option>
                <option value="RESET" ${activeGate === 'RESET' ? 'selected' : ''}>Инициализатор (Reset)</option>
            </select>
        </div>
        <div class="prop-group"><label>Общий масштаб (+ / -)</label><input type="number" id="propScale" value="${p.scale ?? 1.0}" min="0.1" max="10.0" step="0.1" /></div>
        <div class="prop-group"><label>Пружина / Растяжение Z (] / [)</label><input type="number" id="propStretch" value="${p.stretch ?? 1.0}" min="0.1" max="5.0" step="0.1" /></div>
    `;

    document.getElementById('nodeGateSelect')?.addEventListener('change', (e) => {
        node.params.activeGate = e.target.value;
        saveState();
        updateNodeVisual(node);
        logAction('CHANGE_GATE', { id: node.id, gate: node.params.activeGate });
        sendDataToPythonCore(true);
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
    updateEdges();
    updateStats();
    resizeRenderer();
    saveState();
    animate();
}

init();