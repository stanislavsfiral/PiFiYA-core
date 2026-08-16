import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { generateRightBranch, TernarySpatialWalshEngine } from './FractalBuilder.js';

let graph = { nodes: [], edges: [] };
let nextId = 1;

// --- ОНЛАЙН-МОСТ С PYTHON-ЯДРОМ В РЕАЛЬНОМ ВРЕМЕНИ ---
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
            consoleEl.innerHTML = `<div class="line success">⚡ [Ядро онлайн]: Узлов: ${result.computed_nodes} | Хиральность: ${result.metrics.integral_chirality} (+${result.metrics.positive} / -${result.metrics.negative})</div>`;
        }
    } catch (err) {
        console.warn("⚠️ Локальное ядро не отвечает. Убедитесь, что запущен sfiral_server.py");
    }
}

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
            angles: params?.angles ? [...params.angles] : [180,0,90],
            showRight: params?.showRight !== undefined ? params.showRight : true,
            showS: params?.showS !== undefined ? params.showS : true,
            showLeft: params?.showLeft !== undefined ? params.showLeft : true,
            showSLeft: params?.showSLeft !== undefined ? params.showSLeft : true
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

const container = document.getElementById('canvasContainer');
const canvas = document.getElementById('renderCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
const ambient = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambient);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
dirLight.position.set(1,2,1);
scene.add(dirLight);
const gridHelper = new THREE.GridHelper(1000, 20, 0x00e5ff, 0x1f2d4a);
scene.add(gridHelper);

const objectsGroup = new THREE.Group();
objectsGroup.name = "GIDEON_Fractal_Root_Container";
scene.add(objectsGroup);

const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 5000);
camera.position.set(600, 400, 800);
camera.lookAt(0,0,0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.target.set(0,0,0);
controls.update();

controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN
};

// --- ФУНКЦИЯ РЕНДЕРИНГА (ОБЪЯВЛЕНА ЗАРАНЕЕ) ---
let renderRequested = false;
function requestRender() {
    if (!renderRequested) {
        renderRequested = true;
        requestAnimationFrame(() => {
            controls.update();
            
            if (walshEngine.active) {
                let time = performance.now() * 0.002;
                graph.nodes.forEach(n => {
                    walshEngine.evaluateNode(n, time);
                    updateNodeVisual(n);
                });
            }
            
            updateStats();
            renderer.render(scene, camera);
            renderRequested = false;
        });
    }
}

function createSfiralGroup(node) {
    const group = new THREE.Group();
    const nodeScale = node.params.scale !== undefined ? node.params.scale : 1.0;
    
    const R = (60 + node.params.N * 2) * nodeScale;
    const H = (80 + node.params.N * 2) * nodeScale;
    
    const rightBranch = generateRightBranch(R, H);
    const rightPts = rightBranch.mainPts; 
    const sRightPts = rightBranch.sPts;  
    
    const leftPts = rightPts.map(p => new THREE.Vector3(-p.x, -p.y, -p.z));   
    const sLeftPts = sRightPts.map(p => new THREE.Vector3(-p.x, -p.y, -p.z)); 

    if (node.params.showRight) {
        const rightGeo = new THREE.BufferGeometry().setFromPoints(rightPts);
        const rightMat = new THREE.LineBasicMaterial({ color: 0x00a0ff, transparent: true, opacity: 0.9 });
        const rightLine = new THREE.Line(rightGeo, rightMat);
        rightLine.userData = { nodeId: node.id, part: 'right' };
        group.add(rightLine);
    }

    if (node.params.showS) {
        const sGeo = new THREE.BufferGeometry().setFromPoints(sRightPts);
        const sMat = new THREE.LineBasicMaterial({ color: 0xffe600, transparent: true, opacity: 0.8 });
        const sLine = new THREE.Line(sGeo, sMat);
        sLine.userData = { nodeId: node.id, part: 's' };
        group.add(sLine);
    }

    if (node.params.showLeft) {
        const leftGeo = new THREE.BufferGeometry().setFromPoints(leftPts);
        const leftMat = new THREE.LineBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.9 });
        const leftLine = new THREE.Line(leftGeo, leftMat);
        leftLine.userData = { nodeId: node.id, part: 'left' };
        group.add(leftLine);
    }

    if (node.params.showSLeft) {
        const sLeftGeo = new THREE.BufferGeometry().setFromPoints(sLeftPts);
        const sLeftMat = new THREE.LineBasicMaterial({ color: 0xff8844, transparent: true, opacity: 0.8 });
        const sLeftLine = new THREE.Line(sLeftGeo, sLeftMat);
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

    const angles = node.params.angles || [180,0,90];
    group.rotation.x = THREE.MathUtils.degToRad(angles[0]);
    group.rotation.y = THREE.MathUtils.degToRad(angles[1]);
    group.rotation.z = THREE.MathUtils.degToRad(angles[2]);

    node.entryPoint = rightPts[0].clone();
    node.exitPoint = sRightPts[sRightPts.length-1].clone();

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
    requestRender();
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

function updateChronoQuantumLinks() {
    let activeChronoLinks = [];
    const thresholdDistance = 140;

    for (let i = 0; i < graph.nodes.length; i++) {
        for (let j = i + 1; j < graph.nodes.length; j++) {
            let n1 = graph.nodes[i];
            let n2 = graph.nodes[j];

            let dx = n1.x - n2.x;
            let dy = n1.y - n2.y;
            let dz = n1.z - n2.z;
            let dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

            if (dist < thresholdDistance) {
                let isSuperposition = (n1.quantumState?.intensity < 0.5 && n2.quantumState?.intensity < 0.5);
                activeChronoLinks.push({
                    from: n1.id,
                    to: n2.id,
                    weight: 1.0 - (dist / thresholdDistance),
                    sharedState: isSuperposition
                });
            }
        }
    }
    return activeChronoLinks;
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
        let lineColor = link.sharedState ? 0xffaa00 : 0x00ffcc;
        let mat = new THREE.LineBasicMaterial({ 
            color: lineColor, 
            transparent: true, 
            opacity: 0.3 + link.weight * 0.5 
        });
        
        let line = new THREE.Line(geo, mat);
        line.userData = { isChronoBridge: true };
        objectsGroup.add(line);
    });

    drawAutoEdges();
    updateStats();
    requestRender();
}

function drawAutoEdges() {
    if (autoEdgeLines.length > 0) {
        autoEdgeLines.forEach(line => objectsGroup.remove(line));
        autoEdgeLines = [];
    }

    const threshold = 150;
    const nodeIds = graph.nodes.map(n => n.id);
    for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i+1; j < nodeIds.length; j++) {
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
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            if (dist < threshold) {
                const pts = [exitWorld, entryWorld];
                const geo = new THREE.BufferGeometry().setFromPoints(pts);
                const mat = new THREE.LineDashedMaterial({
                    color: 0x00ff88,
                    dashSize: 5,
                    gapSize: 3,
                    transparent: true,
                    opacity: 0.3
                });
                const line = new THREE.Line(geo, mat);
                line.computeLineDistances();
                objectsGroup.add(line);
                autoEdgeLines.push(line);
            }
        }
    }
}

function updateStats() {
    document.getElementById('nodeCount').textContent = `Узлов: ${graph.nodes.length}`;
    let chronoCount = updateChronoQuantumLinks().length;
    document.getElementById('edgeCount').textContent = `Хроноквантов: ${graph.edges.length + chronoCount}`;
    let total = 0;
    graph.nodes.forEach(n => {
        total += 4 + 2 + n.params.N * n.params.target_len;
    });
    total += graph.edges.length + chronoCount;
    document.getElementById('paramCount').textContent = `Параметров: ${total.toLocaleString()}`;
}

let selectedNodes = [];
let selectedPart = null;

function updateSelectionHighlights() {
    meshMap.forEach((group, id) => {
        const isSelectedNode = selectedNodes.includes(id);
        group.children.forEach(child => {
            if (child.isLine || child.isMesh) {
                const part = child.userData?.part;
                if (isSelectedNode) {
                    if (selectedPart && selectedPart !== part) {
                        child.material.opacity = 0.2;
                    } else {
                        child.material.opacity = 1.0;
                    }
                } else {
                    child.material.opacity = 0.6;
                }
            }
        });
    });
    requestRender();
}

let undoStack = [], redoStack = [];
const MAX_UNDO = 30;

function saveState() {
    const state = {
        nodes: graph.nodes.map(n => ({ ...n, params: { ...n.params, angles: [...n.params.angles] } })),
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
    if (selectedNodes.length > 0) renderProperties(selectedNodes[0]);
    else renderProperties(null);
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
}

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const selectionRect = document.getElementById('selectionRect');

let mouseDownPos = { x: 0, y: 0 };
let mouseDownObjectId = null;
let mouseDownPart = null;
let isDragging = false;
let isDraggingObject = false;
let dragGroupIds = [];
let dragOffset = new THREE.Vector3();
let isBoxSelecting = false;
let boxStart = { x: 0, y: 0 };

function getObjectUnderMouse(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
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
        if (hit && hit.userData?.nodeId) {
            return { nodeId: hit.userData.nodeId, part: hit.userData.part };
        }
    }
    return null;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    mouseDownPos.x = e.clientX;
    mouseDownPos.y = e.clientY;
    const hitData = getObjectUnderMouse(e.clientX, e.clientY);
    mouseDownObjectId = hitData ? hitData.nodeId : null;
    mouseDownPart = hitData ? hitData.part : null;
    isDragging = false;
    isDraggingObject = false;
    isBoxSelecting = false;
    controls.enabled = true;
});

renderer.domElement.addEventListener('pointermove', (e) => {
    const dx = e.clientX - mouseDownPos.x;
    const dy = e.clientY - mouseDownPos.y;
    const dist = Math.sqrt(dx*dx + dy*dy);

    if (!isDragging && (e.buttons & 1) && dist > 5) {
        isDragging = true;
        if (mouseDownObjectId !== null) {
            isDraggingObject = true;
            controls.enabled = false;
            if (!selectedNodes.includes(mouseDownObjectId)) {
                selectedNodes = [mouseDownObjectId];
                selectedPart = mouseDownPart;
                updateSelectionHighlights();
                renderProperties(mouseDownObjectId);
            }
            dragGroupIds = selectedNodes.slice();
            const node = getNode(mouseDownObjectId);
            if (node) {
                const worldPos = new THREE.Vector3(node.x, node.y, node.z);
                const plane = new THREE.Plane();
                plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), worldPos);
                const intersection = new THREE.Vector3();
                const rect = container.getBoundingClientRect();
                mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
                mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
                raycaster.setFromCamera(mouse, camera);
                raycaster.ray.intersectPlane(plane, intersection);
                if (intersection) {
                    dragOffset.copy(worldPos).sub(intersection);
                }
            }
        } else {
            isBoxSelecting = true;
            boxStart.x = mouseDownPos.x;
            boxStart.y = mouseDownPos.y;
            selectionRect.style.display = 'block';
            selectionRect.style.left = boxStart.x + 'px';
            selectionRect.style.top = boxStart.y + 'px';
            selectionRect.style.width = '0px';
            selectionRect.style.height = '0px';
            controls.enabled = false;
        }
    }

    if (isBoxSelecting) {
        const rect = container.getBoundingClientRect();
        const x1 = boxStart.x - rect.left;
        const y1 = boxStart.y - rect.top;
        const x2 = e.clientX - rect.left;
        const y2 = e.clientY - rect.top;
        selectionRect.style.left = Math.min(x1, x2) + 'px';
        selectionRect.style.top = Math.min(y1, y2) + 'px';
        selectionRect.style.width = Math.abs(x2 - x1) + 'px';
        selectionRect.style.height = Math.abs(y2 - y1) + 'px';
        return;
    }

    if (isDraggingObject && dragGroupIds.length > 0) {
        const rect = container.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const node = getNode(dragGroupIds[0]);
        if (!node) return;
        const worldPos = new THREE.Vector3(node.x, node.y, node.z);
        const plane = new THREE.Plane();
        plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), worldPos);
        const intersection = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, intersection);
        if (intersection) {
            const newPos = intersection.clone().add(dragOffset);
            const dx = newPos.x - node.x;
            const dy = newPos.y - node.y;
            const dz = newPos.z - node.z;
            dragGroupIds.forEach(id => {
                const n = getNode(id);
                if (!n) return;
                n.x += dx;
                n.y += dy;
                n.z += dz;
                const mesh = meshMap.get(id);
                if (mesh) mesh.position.set(n.x, n.y, n.z);
            });
            updateEdges();
            if (selectedNodes.length > 0) renderProperties(selectedNodes[0]);
            requestRender();
        }
    }
});

renderer.domElement.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    const dx = e.clientX - mouseDownPos.x;
    const dy = e.clientY - mouseDownPos.y;
    const isClick = Math.sqrt(dx*dx + dy*dy) < 5;

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
        selectedNodes = e.shiftKey ? [...new Set([...selectedNodes, ...newSelection])] : newSelection;
        selectedPart = null;
        updateSelectionHighlights();
        if (selectedNodes.length > 0) renderProperties(selectedNodes[0]);
        else renderProperties(null);
        controls.enabled = true;
        return;
    }

    if (isDraggingObject) {
        isDraggingObject = false;
        saveState();
        dragGroupIds = [];
        controls.enabled = true;
        updateStats();
        sendDataToPythonCore();
        return;
    }

    if (isClick) {
        if (mouseDownObjectId !== null) {
            const id = mouseDownObjectId;
            if (e.shiftKey) {
                selectedNodes = selectedNodes.includes(id) ? selectedNodes.filter(nid => nid !== id) : [...selectedNodes, id];
                selectedPart = null;
            } else {
                selectedNodes = [id];
                selectedPart = mouseDownPart;
            }
            updateSelectionHighlights();
            if (selectedNodes.length > 0) renderProperties(selectedNodes[0]);
            else renderProperties(null);
        } else {
            if (!e.shiftKey) {
                selectedNodes = [];
                selectedPart = null;
                updateSelectionHighlights();
                renderProperties(null);
            }
        }
    }
    isDragging = false;
    mouseDownObjectId = null;
    mouseDownPart = null;
});

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); }
    if (e.key === 'Delete' || e.key === 'Del') { e.preventDefault(); deleteSelected(); }
    if (e.key >= '1' && e.key <= '4') {
        const views = ['perspective', 'top', 'front', 'side'];
        const idx = parseInt(e.key) - 1;
        if (idx < views.length) switchView(views[idx]);
    }
});

function switchView(view) {
    document.querySelectorAll('#view-tools button').forEach(b => b.classList.remove('view-active'));
    document.querySelector(`#view-tools button[data-view="${view}"]`).classList.add('view-active');
    let pos, target = new THREE.Vector3(0,0,0);
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
    requestRender();
}
document.querySelectorAll('#view-tools button').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
});

document.getElementById('toggleWalshBtn').addEventListener('click', () => {
    walshEngine.active = !walshEngine.active;
    const btn = document.getElementById('toggleWalshBtn');
    const consoleEl = document.getElementById('console');
    consoleEl.style.display = 'block';
    if (walshEngine.active) {
        btn.style.background = '#ff00ff';
        btn.style.color = '#0b0f19';
        consoleEl.innerHTML = '<div class="line success">🌀 Троичный пространственный алгоритм Уолша (X,Y,Z) активирован!</div>';
    } else {
        btn.style.background = '#2d1f4a';
        btn.style.color = '#ff00ff';
        consoleEl.innerHTML = '<div class="line">🌀 Троичный алгоритм Уолша выключен.</div>';
        graph.nodes.forEach(n => {
            n.params.showRight = true;
            n.params.showS = true;
            n.params.showLeft = true;
            n.params.showSLeft = true;
            updateNodeVisual(n);
        });
    }
});

function renderProperties(id) {
    const node = getNode(id);
    const container = document.getElementById('propContent');
    if (!node) {
        container.innerHTML = '<div class="empty">Выберите узел или элемент</div>';
        return;
    }
    const p = node.params;
    const qs = node.quantumState || { intensity: 0, psi_real: 0, psi_imag: 0 };
    const isGroup = selectedNodes.length > 1;

    let partInfo = '';
    if (selectedPart) {
        const partNames = { right: 'Правый виток (+1)', s: 'S-переход правый (Нуль)', left: 'Левый виток (-1)', sLeft: 'S-переход левый (Нуль)', center: 'Центральный Нуль (0)' };
        partInfo = `<div style="background:#233554; padding:4px 8px; border-radius:4px; color:#00ffaa; font-size:0.75rem; margin-bottom:4px;">🎯 Выбран элемент: <b>${partNames[selectedPart] || selectedPart}</b></div>`;
    }

    let edgeWeightSection = '';
    if (selectedNodes.length === 2) {
        const edge = graph.edges.find(e => (e.from === selectedNodes[0] && e.to === selectedNodes[1]) || (e.from === selectedNodes[1] && e.to === selectedNodes[0]));
        if (edge) {
            edgeWeightSection = `
                <hr style="border-color:#1f2d4a; margin:6px 0;">
                <div class="prop-group">
                    <label style="color:#ff8800; font-weight:bold;">🔗 Вес связи (Weight)</label>
                    <input type="number" id="propEdgeWeight" value="${edge.weight}" min="0.01" max="5.0" step="0.05" />
                    <button id="applyEdgeWeightBtn" style="margin-top:4px; background:#ff8800; color:#0b0f19; border:none; padding:4px; border-radius:4px; cursor:pointer; font-weight:bold;">Обновить вес связи</button>
                </div>
            `;
        }
    }

    container.innerHTML = `
        ${partInfo}
        <div class="prop-group"><label>ID ${isGroup ? '(Группа: ' + selectedNodes.length + ' шт.)' : ''}</label><input type="text" value="${isGroup ? selectedNodes.join(', ') : node.id}" disabled /></div>
        <div class="prop-group">
            <label>Режим</label>
            <select id="propMode">
                <option value="Single" ${node.mode==='Single'?'selected':''}>Single</option>
                <option value="Axis X" ${node.mode==='Axis X'?'selected':''}>Axis X</option>
                <option value="Axis Y" ${node.mode==='Axis Y'?'selected':''}>Axis Y</option>
                <option value="Axis Z" ${node.mode==='Axis Z'?'selected':''}>Axis Z</option>
            </select>
        </div>
        <div class="prop-row">
            <div class="prop-group"><label>N</label><input type="number" id="propN" value="${p.N}" min="1" max="100" /></div>
            <div class="prop-group"><label>target_len</label><input type="number" id="propTargetLen" value="${p.target_len}" min="100" max="100000" step="100" /></div>
        </div>
        <div class="prop-row">
            <div class="prop-group"><label>Масштаб (scale)</label><input type="number" id="propScale" value="${p.scale !== undefined ? p.scale : 1.0}" min="0.01" max="10" step="0.01" /></div>
        </div>
        <div class="prop-group" style="background:#1f2d4a; padding:6px; border-radius:4px; margin-top:4px;">
            <label style="color:#00ffaa; font-weight:bold; margin-bottom:2px;">Компоненты Сфирали (Триединство):</label>
            <label style="display:flex; align-items:center; gap:6px; margin-top:3px; color:#00a0ff; font-weight:bold;"><input type="checkbox" id="chkRight" ${p.showRight !== false ? 'checked' : ''}> Правый виток (+1)</label>
            <label style="display:flex; align-items:center; gap:6px; margin-top:3px; color:#ffe600; font-weight:bold;"><input type="checkbox" id="chkS" ${p.showS !== false ? 'checked' : ''}> S-переход правый (0)</label>
            <label style="display:flex; align-items:center; gap:6px; margin-top:3px; color:#ff4444; font-weight:bold;"><input type="checkbox" id="chkLeft" ${p.showLeft !== false ? 'checked' : ''}> Левый виток (-1)</label>
            <label style="display:flex; align-items:center; gap:6px; margin-top:3px; color:#ff8844; font-weight:bold;"><input type="checkbox" id="chkSLeft" ${p.showSLeft !== false ? 'checked' : ''}> S-переход левый (0)</label>
        </div>
        <div class="prop-group">
            <label>Углы (X,Y,Z) °</label>
            <div class="prop-row">
                <input type="number" id="propAngleX" value="${p.angles[0]}" step="5" />
                <input type="number" id="propAngleY" value="${p.angles[1]}" step="5" />
                <input type="number" id="propAngleZ" value="${p.angles[2]}" step="5" />
            </div>
        </div>
        <div class="prop-group">
            <label>Позиция</label>
            <div class="prop-row">
                <input type="number" id="propPosX" value="${node.x}" step="1" />
                <input type="number" id="propPosY" value="${node.y}" step="1" />
                <input type="number" id="propPosZ" value="${node.z}" step="1" />
            </div>
        </div>
        <div style="background:#1f2d4a; padding:6px; border-radius:4px; margin-top:4px;">
            <div style="color:#00ffaa; font-weight:bold; margin-bottom:2px;">Квантовое состояние:</div>
            <div>Интенсивность I: ${qs.intensity.toFixed(4)}</div>
            <div>Ψ: ${qs.psi_real.toFixed(2)}${qs.psi_imag >= 0 ? '+' : ''}${qs.psi_imag.toFixed(2)}j</div>
        </div>
        <button id="applyPropsBtn" style="margin-top:6px;background:#00e5ff;color:#0b0f19;border:none;padding:4px;border-radius:4px;cursor:pointer;">Применить к выделенным</button>
        ${edgeWeightSection}
    `;

    document.getElementById('applyPropsBtn').addEventListener('click', () => {
        const mode = document.getElementById('propMode').value;
        const N = parseInt(document.getElementById('propN').value) || 5;
        const target_len = parseInt(document.getElementById('propTargetLen').value) || 1000;
        const scaleVal = parseFloat(document.getElementById('propScale').value) || 1.0;
        const showR = document.getElementById('chkRight').checked;
        const showS = document.getElementById('chkS').checked;
        const showLVal = document.getElementById('chkLeft').checked;
        const showSL = document.getElementById('chkSLeft').checked;
        const ax = parseFloat(document.getElementById('propAngleX').value) || 0;
        const ay = parseFloat(document.getElementById('propAngleY').value) || 0;
        const az = parseFloat(document.getElementById('propAngleZ').value) || 0;
        const newX = parseFloat(document.getElementById('propPosX').value) || 0;
        const newY = parseFloat(document.getElementById('propPosY').value) || 0;
        const newZ = parseFloat(document.getElementById('propPosZ').value) || 0;

        saveState();
        const targetNodes = selectedNodes.map(nid => getNode(nid)).filter(Boolean);
        if (targetNodes.length === 0) return;

        const mainNode = targetNodes[0];
        const dx = newX - mainNode.x;
        const dy = newY - mainNode.y;
        const dz = newZ - mainNode.z;

        targetNodes.forEach(n => {
            n.mode = mode;
            n.params.N = N;
            n.params.target_len = target_len;
            n.params.scale = scaleVal;
            n.params.showRight = showR;
            n.params.showS = showS;
            n.params.showLeft = showLVal;
            n.params.showSLeft = showSL;
            n.params.angles = [ax, ay, az];
            if (n === mainNode) { n.x = newX; n.y = newY; n.z = newZ; }
            else { n.x += dx; n.y += dy; n.z += dz; }
            updateNodeVisual(n);
        });
        updateEdges();
        updateStats();
        renderProperties(mainNode.id);
        sendDataToPythonCore();
    });

    const applyEdgeBtn = document.getElementById('applyEdgeWeightBtn');
    if (applyEdgeBtn) {
        applyEdgeBtn.addEventListener('click', () => {
            const newWeight = parseFloat(document.getElementById('propEdgeWeight').value);
            if (isNaN(newWeight)) return;
            saveState();
            const edge = graph.edges.find(e => (e.from === selectedNodes[0] && e.to === selectedNodes[1]) || (e.from === selectedNodes[1] && e.to === selectedNodes[0]));
            if (edge) {
                edge.weight = newWeight;
                updateEdges();
                updateStats();
                const consoleEl = document.getElementById('console');
                consoleEl.style.display = 'block';
                consoleEl.innerHTML = `<div class="line success">🔗 Вес связи между узлами ${edge.from} и ${edge.to} изменен на ${newWeight}</div>`;
                sendDataToPythonCore();
            }
        });
    }
}

async function applyGlobalFractalization() {
    saveState();
    const depth = parseInt(document.getElementById('fractalDepthInput').value) || 3;

    const progressContainer = document.getElementById('progressBarContainer');
    const progressFill = document.getElementById('progressBarFill');
    const progressLabel = document.getElementById('progressLabel');
    progressContainer.style.display = 'block';

    const startTime = performance.now();

    graph.nodes = [];
    graph.edges = [];
    nextId = 1;

    const n1 = addNode('Single', 0, 0, 0, { N: 5, target_len: 1000, scale: 1.0, angles: [180, 0, 90] });
    const n6 = addNode('Single', 0, 0, 0, { N: 5, target_len: 1000, scale: 1.0, angles: [180, 180, -90] });
    addEdge(n1.id, n6.id, 1.0);

    let activePairs = [
        { parent1: n1, parent2: n6, pos: new THREE.Vector3(0, 0, 0), scale: 1.0, len: 1000 }
    ];

    for (let d = 1; d <= depth; d++) {
        let nextPairs = [];
        const scaleVal = Math.pow(0.5, d);
        const targetLen = Math.max(100, 1000 * scaleVal);
        const stepY = 35.0 * Math.pow(0.5, d - 1);
        const stepZ = 45.0 * Math.pow(0.5, d - 1);

        for (let pair of activePairs) {
            const pX = pair.pos.x;
            const pY = pair.pos.y;
            const pZ = pair.pos.z;

            const subN2 = addNode('Single', pX, pY + stepY, pZ + stepZ, {
                N: 5, target_len: targetLen, scale: scaleVal, angles: [0, 180, -90]
            });
            const subN5 = addNode('Single', pX, pY + stepY, pZ + stepZ, {
                N: 5, target_len: targetLen, scale: scaleVal, angles: [0, 0, 90]
            });
            addEdge(subN2.id, subN5.id, Math.max(0.2, 0.8 - d * 0.1));
            addEdge(pair.parent1.id, subN2.id, 0.8);

            const subN3 = addNode('Single', pX, pY - stepY, pZ - stepZ, {
                N: 5, target_len: targetLen, scale: scaleVal, angles: [0, 180, -90]
            });
            const subN4 = addNode('Single', pX, pY - stepY, pZ - stepZ, {
                N: 5, target_len: targetLen, scale: scaleVal, angles: [0, 0, 90]
            });
            addEdge(subN3.id, subN4.id, Math.max(0.2, 0.8 - d * 0.1));
            addEdge(pair.parent2.id, subN3.id, 0.8);

            nextPairs.push(
                { parent1: subN2, parent2: subN5, pos: new THREE.Vector3(pX, pY + stepY, pZ + stepZ), scale: scaleVal, len: targetLen },
                { parent1: subN3, parent2: subN4, pos: new THREE.Vector3(pX, pY - stepY, pZ - stepZ), scale: scaleVal, len: targetLen }
            );
        }
        activePairs = nextPairs;

        progressFill.style.width = `${Math.round((d / depth) * 100)}%`;
        progressLabel.textContent = `Запекание фрактала уровня ${d}/${depth}`;
        await new Promise(resolve => requestAnimationFrame(resolve));
    }

    progressContainer.style.display = 'none';
    updateAllNodes();
    selectedNodes = [n1.id];
    selectedPart = null;
    updateSelectionHighlights();
    renderProperties(n1.id);
    sendDataToPythonCore();

    const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);
    const consoleEl = document.getElementById('console');
    consoleEl.style.display = 'block';
    consoleEl.innerHTML = `<div class="line success">✨ Фрактал уровня ${depth} успешно запечен по шаблону за ${totalTime} сек! Узлов: ${graph.nodes.length}</div>`;
}

function buildFractalComposition() {
    saveState();
    graph.nodes = [];
    graph.edges = [];
    nextId = 1;

    const n1 = addNode('Single', 0, 0, 0, { N: 5, target_len: 1000, scale: 1.0, angles: [180, 0, 90] });
    const n2 = addNode('Single', 0, 35, 45, { N: 5, target_len: 500, scale: 0.5, angles: [0, 180, -90] });
    const n3 = addNode('Single', 0, -35, -45, { N: 5, target_len: 500, scale: 0.5, angles: [0, 180, -90] });
    const n4 = addNode('Single', 0, -35, -45, { N: 5, target_len: 500, scale: 0.5, angles: [0, 0, 90] });
    const n5 = addNode('Single', 0, 35, 45, { N: 5, target_len: 500, scale: 0.5, angles: [0, 0, 90] });
    const n6 = addNode('Single', 0, 0, 0, { N: 5, target_len: 1000, scale: 1.0, angles: [180, 180, -90] });

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

    const consoleEl = document.getElementById('console');
    consoleEl.style.display = 'block';
    consoleEl.innerHTML = '<div class="line success">✨ Эталонная модель Сфирали загружена!</div>';
}

function copySelected() {
    if (selectedNodes.length === 0) return alert('Нет выделенных узлов');
    saveState();
    const idMap = {};
    const newIds = [];
    
    selectedNodes.forEach(id => {
        const src = getNode(id);
        if (!src) return;
        const newNode = addNode(src.mode, src.x, src.y, src.z, {
            N: src.params.N,
            target_len: src.params.target_len,
            scale: src.params.scale,
            angles: [...src.params.angles],
            showRight: src.params.showRight,
            showS: src.params.showS,
            showLeft: src.params.showLeft,
            showSLeft: src.params.showSLeft
        });
        idMap[id] = newNode.id;
        newIds.push(newNode.id);
        updateNodeVisual(newNode);
    });

    graph.edges.forEach(edge => {
        if (selectedNodes.includes(edge.from) && selectedNodes.includes(edge.to)) {
            const newFrom = idMap[edge.from], newTo = idMap[edge.to];
            if (newFrom && newTo) addEdge(newFrom, newTo, edge.weight);
        }
    });

    if (document.getElementById('groupMoveX')) document.getElementById('groupMoveX').value = '0';
    if (document.getElementById('groupMoveY')) document.getElementById('groupMoveY').value = '0';
    if (document.getElementById('groupMoveZ')) document.getElementById('groupMoveZ').value = '0';

    updateEdges();
    updateStats();
    selectedNodes = newIds;
    selectedPart = null;
    updateSelectionHighlights();
    if (selectedNodes.length > 0) renderProperties(selectedNodes[0]);
    sendDataToPythonCore();
}

function applyPercentScale() {
    if (selectedNodes.length === 0) return alert('Нет выделенных узлов');
    saveState();
    const scaleFactor = (parseFloat(document.getElementById('scalePercentInput').value) || 99) / 100.0;
    let cx = 0, cy = 0, cz = 0;
    const targetNodes = selectedNodes.map(id => getNode(id)).filter(Boolean);
    if (targetNodes.length === 0) return;

    targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
    cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

    targetNodes.forEach(n => {
        n.x = cx + (n.x - cx) * scaleFactor;
        n.y = cy + (n.y - cy) * scaleFactor;
        n.z = cz + (n.z - cz) * scaleFactor;
        n.params.scale = (n.params.scale !== undefined ? n.params.scale : 1.0) * scaleFactor;
        n.params.target_len = Math.max(50, Math.round(n.params.target_len * scaleFactor));
        if (n.params.N > 1) n.params.N = Math.max(1, Math.round(n.params.N * scaleFactor));
        updateNodeVisual(n);
    });
    updateEdges();
    updateStats();
    if (selectedNodes.length > 0) renderProperties(selectedNodes[0]);
    sendDataToPythonCore();
}

function deleteSelected() {
    if (selectedNodes.length === 0) return alert('Выберите узлы');
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

    if (!confirm(`Удалить ${selectedNodes.length} узлов целиком?`)) return;
    selectedNodes.forEach(id => {
        removeNode(id);
        if (meshMap.has(id)) { objectsGroup.remove(meshMap.get(id)); meshMap.delete(id); }
    });
    selectedNodes = [];
    selectedPart = null;
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
        if (edge) { 
            updateEdges(); 
            updateStats(); 
            sendDataToPythonCore();
        }
        else alert('Связь уже существует');
    } else {
        alert('Выделите ровно два узла');
    }
}

document.getElementById('addNodeBtn').addEventListener('click', () => {
    saveState();
    const count = graph.nodes.length;
    const node = addNode('Single', (count % 5 - 2) * 80, Math.floor(count / 5) * 80, 0, { N: 5, target_len: 1000, scale: 1.0, angles: [180,0,90] });
    updateNodeVisual(node);
    updateEdges();
    updateStats();
    selectedNodes = [node.id];
    selectedPart = null;
    updateSelectionHighlights();
    renderProperties(node.id);
    sendDataToPythonCore();
});

document.getElementById('applyGlobalFractalBtn').addEventListener('click', applyGlobalFractalization);
document.getElementById('copyGroupBtn').addEventListener('click', copySelected);
document.getElementById('applyScalePercentBtn').addEventListener('click', applyPercentScale);
document.getElementById('deleteBtn').addEventListener('click', deleteSelected);
document.getElementById('connectBtn').addEventListener('click', connectSelected);

document.getElementById('applyGroupMoveBtn').addEventListener('click', () => {
    if (selectedNodes.length === 0) return alert('Нет выделенных узлов');
    saveState();
    
    const targetX = parseFloat(document.getElementById('groupMoveX').value);
    const targetY = parseFloat(document.getElementById('groupMoveY').value);
    const targetZ = parseFloat(document.getElementById('groupMoveZ').value);

    let cx = 0, cy = 0, cz = 0;
    const targetNodes = selectedNodes.map(id => getNode(id)).filter(Boolean);
    if (targetNodes.length === 0) return;

    targetNodes.forEach(n => { cx += n.x; cy += n.y; cz += n.z; });
    cx /= targetNodes.length; cy /= targetNodes.length; cz /= targetNodes.length;

    const dx = !isNaN(targetX) ? targetX - cx : 0;
    const dy = !isNaN(targetY) ? targetY - cy : 0;
    const dz = !isNaN(targetZ) ? targetZ - cz : 0;

    targetNodes.forEach(n => {
        n.x += dx;
        n.y += dy;
        n.z += dz;
        updateNodeVisual(n);
    });

    updateEdges();
    updateStats();
    if (selectedNodes.length > 0) renderProperties(selectedNodes[0]);
    requestRender();
    sendDataToPythonCore();
});

document.getElementById('applyGroupRotBtn').addEventListener('click', () => {
    if (selectedNodes.length === 0) return alert('Нет выделенных');
    saveState();
    const rx = parseFloat(document.getElementById('groupRotX').value) || 0;
    const ry = parseFloat(document.getElementById('groupRotY').value) || 0;
    const rz = parseFloat(document.getElementById('groupRotZ').value) || 0;

    let cx = 0, cy = 0, cz = 0;
    selectedNodes.forEach(id => { const n = getNode(id); if (n) { cx += n.x; cy += n.y; cz += n.z; } });
    cx /= selectedNodes.length; cy /= selectedNodes.length; cz /= selectedNodes.length;

    const quatGroup = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(rx), THREE.MathUtils.degToRad(ry), THREE.MathUtils.degToRad(rz), 'XYZ'));

    selectedNodes.forEach(id => {
        const n = getNode(id);
        if (!n) return;
        let pos = new THREE.Vector3(n.x - cx, n.y - cy, n.z - cz).applyQuaternion(quatGroup);
        n.x = cx + pos.x; n.y = cy + pos.y; n.z = cz + pos.z;

        const currentQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(n.params.angles[0]), THREE.MathUtils.degToRad(n.params.angles[1]), THREE.MathUtils.degToRad(n.params.angles[2]), 'XYZ'));
        currentQuat.premultiply(quatGroup);
        const finalEuler = new THREE.Euler().setFromQuaternion(currentQuat, 'XYZ');
        n.params.angles[0] = (THREE.MathUtils.radToDeg(finalEuler.x) + 360) % 360;
        n.params.angles[1] = (THREE.MathUtils.radToDeg(finalEuler.y) + 360) % 360;
        n.params.angles[2] = (THREE.MathUtils.radToDeg(finalEuler.z) + 360) % 360;
        updateNodeVisual(n);
    });
    updateEdges();
    updateStats();
    updateSelectionHighlights();
    if (selectedNodes.length > 0) renderProperties(selectedNodes[0]);
    sendDataToPythonCore();
});

document.getElementById('simulateBtn').addEventListener('click', () => {
    if (graph.nodes.length === 0) { alert('Нет узлов'); return; }
    const consoleEl = document.getElementById('console');
    consoleEl.style.display = 'block';
    consoleEl.innerHTML = '<div class="line">⚙️ Запуск квантово-оптического симулятора Сфирали...</div>';

    let psi = {};
    graph.nodes.forEach(n => { psi[n.id] = { real: Math.random(), imag: Math.random() }; });
    let iteration = 0, energyHistory = [];

    const optimizeInterval = setInterval(() => {
        iteration++;
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
            nextPsi[v].real += trReal;
            nextPsi[v].imag += trImag;
        });
        psi = nextPsi;

        let totalEnergy = 0;
        graph.nodes.forEach(n => {
            const p = psi[n.id] || { real: 0, imag: 0 };
            const intensity = (p.real * p.real) + (p.imag * p.imag);
            n.quantumState = { intensity, psi_real: p.real, psi_imag: p.imag };
            totalEnergy += intensity;
            updateNodeVisual(n);
        });

        energyHistory.push(totalEnergy);
        consoleEl.innerHTML = `<div class="line">🔄 Шаг симуляции ${iteration}/50 | Энергия: ${totalEnergy.toFixed(4)}</div>`;

        if (iteration >= 50) {
            clearInterval(optimizeInterval);
            updateEdges();
            consoleEl.innerHTML = `<div class="line success">✅ Симуляция завершена. Топология сбалансирована.</div>`;
            if (selectedNodes.length > 0) renderProperties(selectedNodes[0]);
            sendDataToPythonCore();
        }
    }, 40);
});

document.getElementById('saveModelBtn').addEventListener('click', () => {
    if (graph.nodes.length === 0) return alert('Нет узлов');
    const data = JSON.stringify({ model_name: "GIDEON-Fractal-Complex", total_nodes: graph.nodes.length, total_edges: graph.edges.length, nodes: graph.nodes, edges: graph.edges }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'fractal_model_export.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
});

document.getElementById('loadModelBtn').addEventListener('click', () => document.getElementById('fileInput').click());

document.getElementById('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            if (!data.nodes) throw new Error('Неверный формат JSON');
            
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
            data.nodes.forEach(n => {
                minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
                minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
                minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
            });
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            const cz = (minZ + maxZ) / 2;
            const sizeSpan = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
            const autoScale = sizeSpan > 200 ? 200.0 / sizeSpan : 1.0;

            graph.nodes = []; graph.edges = [];
            let maxId = 0;
            data.nodes.forEach(n => { if (n.id > maxId) maxId = n.id; });
            nextId = maxId + 1;

            data.nodes.forEach(n => {
                graph.nodes.push({
                    id: n.id,
                    mode: n.mode || 'Single',
                    x: (n.x - cx) * autoScale,
                    y: (n.y - cy) * autoScale,
                    z: (n.z - cz) * autoScale,
                    params: {
                        N: n.params?.N || 5,
                        target_len: n.params?.target_len || 1000,
                        scale: (n.params?.scale !== undefined ? n.params.scale : 1.0) * autoScale,
                        angles: n.params?.angles ? [...n.params.angles] : [180,0,90],
                        showRight: n.params?.showRight !== undefined ? n.params.showRight : true,
                        showS: n.params?.showS !== undefined ? n.params.showS : true,
                        showLeft: n.params?.showLeft !== undefined ? n.params.showLeft : true,
                        showSLeft: n.params?.showSLeft !== undefined ? n.params.showSLeft : true
                    },
                    quantumState: { intensity: 0, psi_real: 0, psi_imag: 0 }
                });
            });
            if (data.edges) {
                data.edges.forEach(e => {
                    if (getNode(e.from) && getNode(e.to)) graph.edges.push({ from: e.from, to: e.to, weight: e.weight !== undefined ? e.weight : 0.5 });
                });
            }
            updateAllNodes();
            selectedNodes = [];
            selectedPart = null;
            updateSelectionHighlights();
            renderProperties(null);
            sendDataToPythonCore();

            const consoleEl = document.getElementById('console');
            consoleEl.style.display = 'block';
            consoleEl.innerHTML = `<div class="line success">✅ Модель успешно загружена и отмасштабирована! Узлов: ${graph.nodes.length}, Связей: ${graph.edges.length}</div>`;
        } catch(err) { alert('Ошибка загрузки: ' + err.message); }
    };
    reader.readAsText(file);
    e.target.value = '';
});

controls.addEventListener('change', requestRender);

function resizeRenderer() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
}
window.addEventListener('resize', resizeRenderer);

function init() {
    buildFractalComposition();
    resizeRenderer();
    saveState();
    requestRender();
    function ambientLoop() {
        if (walshEngine.active) requestRender();
        requestAnimationFrame(ambientLoop);
    }
    ambientLoop();
}

init();