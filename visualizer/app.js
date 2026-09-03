import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { generateHalfPoints, GideonWebCore, computeQuantumNetwork } from '../core/GideonMath.js?v=dynamic';

let customModelSource = null; 
let customPoints = null;      

let scene, camera, renderer, controls, spiralGroup;
let core = new GideonWebCore();
let globalNodesData = {}; 
let selectedNodeIds = []; 
let isFirstLoad = true; // Флаг для первоначальной настройки камеры

// ========================================================
// ТОПОЛОГИЧЕСКИЙ ШИФР ОТТЕНДОРФА
// ========================================================
class OttendorfFractalAddressing {
    constructor(baseScale = 140.0) {
        this.baseScale = baseScale;
    }

    encodeRecursiveAddress(nodeId, x, y, z, depth = 2, parentPath = '') {
        const macroSector = Math.abs(x) >= Math.abs(y) ? (x > 0 ? 'R' : 'L') : 'S';
        
        let currentSegments = [];
        let currentScale = this.baseScale;

        let cx = x, cy = y, cz = z;
        for (let d = 1; d <= depth; d++) {
            currentScale *= 0.5;
            let fx = Math.floor((cx / currentScale) + 2) % 2;
            let fy = Math.floor((cy / currentScale) + 2) % 2;
            let fz = Math.floor((cz / currentScale) + 2) % 2;
            currentSegments.push(`${fx}${fy}${fz}`);
            
            cx = (cx % currentScale);
            cy = (cy % currentScale);
            cz = (cz % currentScale);
        }

        const subcode = currentSegments.join('.');
        const addressCode = parentPath ? `${parentPath}>SF-${macroSector}-${subcode}` : `SF-${macroSector}-${subcode}`;

        return {
            id: nodeId,
            address: addressCode,
            depth: depth,
            scale: currentScale,
            segments: currentSegments
        };
    }
}
const ottendorfCoder = new OttendorfFractalAddressing(140.0);

const R_sphere = 280.0;
let signalSpheres = [];
let animClock = 0;
let cachedCurvesData = []; 
let lastQuantumResults = []; 

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function init3D() {
    const container = document.getElementById('canvasContainer');
    scene = new THREE.Scene();
    
    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 8000);
    // Первоначальная установка камеры
    camera.position.set(600, 450, 700);

    renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('renderCanvas'), antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0); 
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    const sphereGeo = new THREE.SphereGeometry(R_sphere, 40, 40);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0x00d2ff, wireframe: true, transparent: true, opacity: 0.04 });
    scene.add(new THREE.Mesh(sphereGeo, sphereMat));

    const theta = linspace(0, 2 * Math.PI, 100);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00d2ff, transparent: true, opacity: 0.15 });
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(theta.map(a => new THREE.Vector3(R_sphere * Math.cos(a), R_sphere * Math.sin(a), 0))), lineMat));
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(theta.map(a => new THREE.Vector3(R_sphere * Math.cos(a), 0, R_sphere * Math.sin(a)))), lineMat));
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(theta.map(a => new THREE.Vector3(0, R_sphere * Math.cos(a), R_sphere * Math.sin(a)))), lineMat));

    spiralGroup = new THREE.Group();
    scene.add(spiralGroup);

    window.addEventListener('resize', onWindowResize);
    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('click', onCanvasClick);

    updateScene();
    animate();
}

function onCanvasClick(event) {
    if (!customModelSource || !customModelSource.nodes) return;
    const container = document.getElementById('canvasContainer');
    const rect = container.getBoundingClientRect();
    
    mouse.x = ((event.clientX - rect.left) / container.clientWidth) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / container.clientHeight) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);
    
    let intersects = [];
    spiralGroup.children.forEach(group => {
        let meshes = group.children.filter(c => c.type === 'Mesh' || c.type === 'Line');
        if (meshes.length > 0) {
            let hits = raycaster.intersectObjects(meshes, true);
            if (hits.length > 0) intersects.push({ object: group, distance: hits[0].distance });
        }
    });

    if (intersects.length > 0) {
        intersects.sort((a, b) => a.distance - b.distance);
        const hoveredGroup = intersects[0].object;
        const clickedId = hoveredGroup.name;

        if (event.shiftKey) {
            let idx = selectedNodeIds.indexOf(clickedId);
            if (idx > -1) selectedNodeIds.splice(idx, 1);
            else selectedNodeIds.push(clickedId);
        } else {
            selectedNodeIds = [clickedId];
        }

        let node = customModelSource.nodes.find(n => n.id === clickedId);
        if (node) {
            let ottendorfInfo = ottendorfCoder.encodeRecursiveAddress(node.id, node.x || 0, node.y || 0, node.z || 0, 2);
            
            document.getElementById('selNodeId').innerText = selectedNodeIds.length > 1 ? 
                `Группа (${selectedNodeIds.length})` : `${node.id} [${ottendorfInfo.address}]`;
            document.getElementById('inspectorPanel').style.display = 'flex';

            document.getElementById('insRangeX').value = node.x || 0;
            document.getElementById('insNumX').value = node.x || 0;
            document.getElementById('insRangeY').value = node.y || 0;
            document.getElementById('insNumY').value = node.y || 0;
            document.getElementById('insRangeZ').value = node.z || 0;
            document.getElementById('insNumZ').value = node.z || 0;

            let logEl = document.getElementById('consoleLog');
            if (logEl) {
                const qResult = lastQuantumResults.find(q => q.id === node.id);
                let qStateStr = qResult ? `L:${qResult.qutrit_state.L} | S:${qResult.qutrit_state.S} | R:${qResult.qutrit_state.R}` : 'Ожидание расчета';

                logEl.innerHTML += `
                    <div class="console-line type-sys" style="border-left: 3px solid #ffaa00; padding-left: 6px; margin-top: 4px;">
                        🔍 <b>[OTTENDORF FOCUS]</b> Выбрана вложенная Сфираль ID: <b>${node.id}</b><br>
                        &nbsp;&nbsp;• Фрактальный адрес: <span style="color:#00ffaa;">${ottendorfInfo.address}</span><br>
                        &nbsp;&nbsp;• Масштаб подуровня: ${ottendorfInfo.scale} | Глубина: ${ottendorfInfo.depth}<br>
                        &nbsp;&nbsp;• Квантовое состояние (Кутрит): [${qStateStr}]
                    </div>
                `;
                logEl.scrollTop = logEl.scrollHeight;
            }
        }
    } else if (!event.shiftKey) {
        selectedNodeIds = [];
    }
}

function onMouseMove(event) {
    const container = document.getElementById('canvasContainer');
    const rect = container.getBoundingClientRect();
    
    mouse.x = ((event.clientX - rect.left) / container.clientWidth) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / container.clientHeight) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);
    
    let intersects = [];
    spiralGroup.children.forEach(group => {
        let meshes = group.children.filter(c => c.type === 'Mesh');
        if (meshes.length > 0) {
            let hits = raycaster.intersectObjects(meshes);
            if (hits.length > 0) intersects.push({ object: group, distance: hits[0].distance });
        }
    });

    const tooltip = document.getElementById('nodeTooltip');
    if (intersects.length > 0) {
        intersects.sort((a, b) => a.distance - b.distance);
        const hoveredGroup = intersects[0].object;
        const nodeId = hoveredGroup.name;
        const qData = lastQuantumResults.find(q => q.id === nodeId);
        
        if (qData && tooltip) {
            document.getElementById('ttNodeId').innerText = qData.id;
            document.getElementById('ttGate').innerText = qData.activeGate || 'N/A';
            document.getElementById('ttProbL').innerText = qData.qutrit_state.L.toFixed(3);
            document.getElementById('ttProbS').innerText = qData.qutrit_state.S.toFixed(3);
            document.getElementById('ttProbR').innerText = qData.qutrit_state.R.toFixed(3);
            
            tooltip.style.display = 'block';
            tooltip.style.left = (event.clientX + 15) + 'px';
            tooltip.style.top = (event.clientY + 15) + 'px';
        }
    } else {
        if (tooltip) tooltip.style.display = 'none';
    }
}

function linspace(start, end, n) {
    let arr = [];
    for (let i = 0; i < n; i++) arr.push(start + (end - start) * (i / (n - 1)));
    return arr;
}

function onWindowResize() {
    const container = document.getElementById('canvasContainer');
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

function rotateCoords(x, y, z, angleDeg, axis) {
    let rad = angleDeg * Math.PI / 180.0;
    let c = Math.cos(rad), s = Math.sin(rad);
    if (axis === 'Harmonic X') return { x: x, y: y * c - z * s, z: y * s + z * c };
    if (axis === 'Harmonic Y') return { x: x * c + z * s, y: y, z: -x * s + z * c };
    return { x: x * c - y * s, y: x * s + y * c, z: z };
}

function clearGroup(group) {
    while(group.children.length > 0){ group.remove(group.children[0]); }
}

async function computeQuantumState(nodes, edges) {
    let logEl = document.getElementById('consoleLog');
    if (!logEl) return;
    logEl.innerHTML += `<div class="console-line type-sys">[NETWORK] Расчет топологии в автономном JS-ядре...</div>`;
    logEl.scrollTop = logEl.scrollHeight;

    try {
        const startTime = performance.now();
        const nodesQuantum = computeQuantumNetwork(nodes, edges || []);
        const executionTime = (performance.now() - startTime).toFixed(2);
        
        logEl.innerHTML += `<div class="console-line type-qcore">⚡ [Q-CORE] Вычисление завершено за ${executionTime}мс.</div>`;
        lastQuantumResults = nodesQuantum;
        logEl.scrollTop = logEl.scrollHeight;
    } catch (error) {
        console.error("❌ Ошибка автономного расчета:", error);
    }
}

function updateScene() {
    clearGroup(spiralGroup);
    signalSpheres = [];
    cachedCurvesData = [];
    globalNodesData = {}; 

    let mode = document.getElementById('modeSelect').value;
    let harmAxis = document.getElementById('harmAxisSelect').value;
    let nCores = parseInt(document.getElementById('coresInput').value) || 1;
    let quenchRate = parseFloat(document.getElementById('quenchInput').value) || 1.0;
    let angleStep = 360.0 / nCores;

    if (customModelSource && customModelSource.nodes) {
        document.getElementById('statusHeader').innerText = `STATUS: ACTIVE • ${customModelSource.nodes.length} NODES`;
        document.getElementById('resetModelBtn').style.display = 'block';

        customModelSource.nodes.forEach(node => {
            const nodeGroup = new THREE.Group();
            nodeGroup.name = node.id; 
            
            let px = node.x !== undefined ? node.x : 0;
            let py = node.y !== undefined ? node.y : 0;
            let pz = node.z !== undefined ? node.z : 0;
            nodeGroup.position.set(px, py, pz);

            const angles = (node.params && node.params.angles) ? node.params.angles : [0, 0, 0];
            const euler = new THREE.Euler(
                THREE.MathUtils.degToRad(angles[0]),
                THREE.MathUtils.degToRad(angles[1]),
                THREE.MathUtils.degToRad(angles[2])
            );
            nodeGroup.rotation.copy(euler);

            let nodeScale = (node.params && node.params.scale !== undefined) ? node.params.scale : 1.0;
            let nodeStretch = (node.params && node.params.stretch !== undefined) ? node.params.stretch : 1.0;
            let nodeN = (node.params && node.params.N !== undefined) ? node.params.N : 5;

            // Синхронизация базовых габаритов геометрии с формулами конструктора
            let baseR = 60 + nodeN * 2; 
            let baseH = 80 + nodeN * 2; 

            // Генерация базовой структуры строго по размерам редактора
            const basePtsObj = generateHalfPoints(baseR, baseH, 1.0, 1.0); 

            // Применяем масштаб и растяжение синхронно по всем осям
            const transformScale = new THREE.Vector3(nodeScale, nodeScale, nodeScale * nodeStretch);

            let splitIdx = Math.floor(basePtsObj.x.length * 0.62); 
            
            if (basePtsObj.x.length > 0) {
                let r0 = Math.sqrt(basePtsObj.x[0]**2 + basePtsObj.y[0]**2);
                for(let i=0; i<basePtsObj.x.length; i++) {
                    let r = Math.sqrt(basePtsObj.x[i]**2 + basePtsObj.y[i]**2);
                    if (r0 - r > 1.0) { 
                        splitIdx = Math.max(0, i - 1); 
                        break; 
                    }
                }
            }

            let fullPts = [];
            for(let i=0; i<basePtsObj.x.length; i++) {
                let p = new THREE.Vector3(basePtsObj.x[i], basePtsObj.y[i], basePtsObj.z[i]);
                p.multiply(transformScale); 
                fullPts.push(p);
            }
            let aPts = fullPts.map(p => new THREE.Vector3(-p.x, -p.y, -p.z));
            
            let flowRightToLeft = [];
            for(let i=0; i<fullPts.length; i++) { flowRightToLeft.push(fullPts[i].clone()); }
            for(let i=fullPts.length-1; i>=0; i--) { flowRightToLeft.push(new THREE.Vector3(-fullPts[i].x, -fullPts[i].y, -fullPts[i].z)); }

            const rightPts = fullPts.slice(0, splitIdx + 1);
            const leftPts = aPts.slice(0, splitIdx + 1).reverse();
            const sPts = fullPts.slice(splitIdx);
            for(let i = aPts.length - 2; i >= splitIdx; i--) sPts.push(aPts[i]);

            nodeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPts), new THREE.LineBasicMaterial({ color: 0x00a0ff, transparent: true, opacity: 1.0 })));
            nodeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sPts), new THREE.LineBasicMaterial({ color: 0xffe600, transparent: true, opacity: 1.0 })));
            nodeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPts), new THREE.LineBasicMaterial({ color: 0xff4444, transparent: true, opacity: 1.0 })));
            
            let centerMesh = new THREE.Mesh(new THREE.SphereGeometry(2 * nodeScale, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
            nodeGroup.add(centerMesh);
            spiralGroup.add(nodeGroup);

            const pos = new THREE.Vector3(px, py, pz);
            let worldPath = flowRightToLeft.map(p => p.clone().applyEuler(euler).add(pos));
            let sphereMesh = new THREE.Mesh(new THREE.SphereGeometry(2.5 * nodeScale, 16, 16), new THREE.MeshBasicMaterial({ color: 0x00ffcc }));
            sphereMesh.visible = true; // Сферы снова видимы
            spiralGroup.add(sphereMesh);
            
            signalSpheres.push({ mesh: sphereMesh, points: worldPath, speedMultiplier: 0.8, isLinear: true, tOffset: Math.random() });

            globalNodesData[node.id] = {
                id: node.id,
                worldPath: worldPath,
                entryPort: worldPath[0],
                exitPort: worldPath[worldPath.length - 1],
                next: null,
                sphereMesh: sphereMesh
            };
        });

        if (customModelSource.edges && customModelSource.edges.length > 0) {
            customModelSource.edges.forEach(edge => {
                let nFrom = globalNodesData[edge.from];
                let nTo = globalNodesData[edge.to];
                if (nFrom && nTo) {
                    nFrom.next = nTo.id; 
                    if (edge.draw || edge.type === 'manual_wire') {
                        let pts = [nFrom.exitPort, nTo.entryPort];
                        spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x4466aa, transparent: true, opacity: 0.5, linewidth: 2 })));
                    }
                }
            });
        }
        
        const box = new THREE.Box3().setFromObject(spiralGroup);
        const center = new THREE.Vector3();
        box.getCenter(center);
        
        // Убрали сброс камеры, теперь фокус меняется плавно только если это нужно,
        // но сама камера не прыгает.
        controls.target.copy(center);

        computeQuantumState(customModelSource.nodes, customModelSource.edges);

    } else {
        document.getElementById('statusHeader').innerText = "STATUS: ACTIVE • Q-ZERO CHIRALITY";
        document.getElementById('resetModelBtn').style.display = customPoints ? 'block' : 'none';

        // Дефолтное отображение оставляем с прежними крупными габаритами
        let rawStruct = generateHalfPoints(140, 190);
        let rawX = rawStruct.x, rawY = rawStruct.y, rawZ = rawStruct.z;

        let splitIdx = Math.floor(rawX.length * 0.62);
        if (rawX.length > 0) {
            let r0 = Math.sqrt(rawX[0]**2 + rawY[0]**2);
            for(let i=0; i<rawX.length; i++) {
                let r = Math.sqrt(rawX[i]**2 + rawY[i]**2);
                if (r0 - r > 1.0) { splitIdx = Math.max(0, i - 1); break; }
            }
        }

        for (let k = 0; k < nCores; k++) {
            let angle = k * angleStep;
            let tPoints = [], aPoints = [];
            for (let i = 0; i < rawX.length; i++) {
                let p1 = rotateCoords(rawX[i], rawY[i], rawZ[i], angle, harmAxis);
                tPoints.push(new THREE.Vector3(p1.x, p1.y, p1.z));
                aPoints.push(new THREE.Vector3(-p1.x, -p1.y, -p1.z));
            }

            let rightPts = tPoints.slice(0, splitIdx + 1);
            let leftPts = aPoints.slice(0, splitIdx + 1).reverse();
            let sPts = tPoints.slice(splitIdx);
            for(let i = aPoints.length - 2; i >= splitIdx; i--) sPts.push(aPoints[i]);

            spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPts), new THREE.LineBasicMaterial({ color: 0x00e5ff, linewidth: 2, transparent: true, opacity: 0.7 })));
            spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sPts), new THREE.LineBasicMaterial({ color: 0xffe600, linewidth: 2, transparent: true, opacity: 0.7 })));
            spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPts), new THREE.LineBasicMaterial({ color: 0xff3366, linewidth: 2, transparent: true, opacity: 0.7 })));

            cachedCurvesData.push({ points: tPoints, color: 0x00ffff });
            cachedCurvesData.push({ points: aPoints, color: 0xff0055 });

            if (mode !== 'Single') {
                let t2Points = [], a2Points = [];
                for (let i = 0; i < rawX.length; i++) {
                    let p1 = rotateCoords(rawX[i], rawY[i], rawZ[i], angle, harmAxis);
                    let p2, p3;
                    if (mode === 'Axis X') { p2 = { x: p1.x, y: -p1.y, z: -p1.z }; p3 = { x: -p1.x, y: p1.y, z: p1.z }; } 
                    else if (mode === 'Axis Y') { p2 = { x: -p1.x, y: p1.y, z: -p1.z }; p3 = { x: p1.x, y: -p1.y, z: p1.z }; } 
                    else { p2 = { x: -p1.x, y: -p1.y, z: p1.z }; p3 = { x: p1.x, y: p1.y, z: -p1.z }; }
                    t2Points.push(new THREE.Vector3(p2.x, p2.y, p2.z));
                    a2Points.push(new THREE.Vector3(p3.x, p3.y, p3.z));
                }
                
                let rightPts2 = t2Points.slice(0, splitIdx + 1);
                let leftPts2 = a2Points.slice(0, splitIdx + 1).reverse();
                let sPts2 = t2Points.slice(splitIdx);
                for(let i = a2Points.length - 2; i >= splitIdx; i--) sPts2.push(a2Points[i]);

                spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPts2), new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2, transparent: true, opacity: 0.6 })));
                spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sPts2), new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 2, transparent: true, opacity: 0.6 })));
                spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPts2), new THREE.LineBasicMaterial({ color: 0xff8800, linewidth: 2, transparent: true, opacity: 0.6 })));

                cachedCurvesData.push({ points: t2Points, color: 0x55ffaa });
                cachedCurvesData.push({ points: a2Points, color: 0xffaa00 });
            }
        }

        const sphereGeo = new THREE.SphereGeometry(3, 16, 16);
        cachedCurvesData.forEach(curve => {
            let mesh = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: curve.color }));
            spiralGroup.add(mesh);
            signalSpheres.push({ mesh: mesh, points: curve.points, isLinear: false, tOffset: 0 });
        });

        let p1 = [1, 0, -1, 1, 0];
        let p2 = [-1, 1, 0, -1, 1];
        let results = core.processStream(p1, p2, nCores, mode, harmAxis);
        let adamBalanceVal = core.calculateAdamBalance(p1, results, mode, quenchRate);

        document.getElementById('statDefects').innerText = adamBalanceVal.toFixed(4);
        document.getElementById('statChirality').innerText = "0.0 (Нулевая балансировка)";
        document.getElementById('statAngle').innerText = angleStep.toFixed(1) + "°";
        document.getElementById('statHadamard').innerText = mode === 'Single' ? "ОРТОГОНАЛЬНО" : `ДИПОЛЬ (${mode})`;
    }
}

function animate() {
    requestAnimationFrame(animate);
    let quenchVal = parseFloat(document.getElementById('quenchInput').value) || 1.0;
    let speedMultiplier = parseFloat(document.getElementById('animSpeedRange').value) || 1.0;
    animClock += 0.015 * quenchVal * speedMultiplier;

    signalSpheres.forEach(item => {
        if (item.points && item.points.length > 0) {
            let t = item.isLinear ? 
                (animClock * (item.speedMultiplier || 0.15) + (item.tOffset || 0)) % 1.0 : 
                (1 - Math.cos((animClock % Math.PI * 2))) / 2.0;
            let idx = Math.floor(t * (item.points.length - 1));
            if (item.points[idx]) item.mesh.position.set(item.points[idx].x, item.points[idx].y, item.points[idx].z);
        }
    });

    if (controls) controls.update();
    renderer.render(scene, camera);
}

document.getElementById('modeSelect').addEventListener('change', updateScene);
document.getElementById('harmAxisSelect').addEventListener('change', updateScene);
document.getElementById('coresInput').addEventListener('change', updateScene);

let consoleCollapsed = false;
document.getElementById('toggleConsoleBtn').addEventListener('click', () => {
    consoleCollapsed = !consoleCollapsed;
    document.getElementById('consoleLog').classList.toggle('collapsed', consoleCollapsed);
    document.getElementById('toggleConsoleBtn').innerText = consoleCollapsed ? 'Развернуть 🔽' : 'Свернуть 🔼';
});

document.getElementById('clearLogBtn').addEventListener('click', () => { document.getElementById('consoleLog').innerHTML = ''; });
document.getElementById('loadModelBtn').addEventListener('click', () => { document.getElementById('modelFileInput').click(); });

document.getElementById('modelFileInput').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            let data = JSON.parse(e.target.result);
            if (data.graph && Array.isArray(data.graph.nodes)) data = data.graph;
            if (data.nodes && Array.isArray(data.nodes)) {
                customModelSource = data;
                customPoints = null;
            }
            document.getElementById('resetModelBtn').style.display = 'block';
            
            // Если загружена новая модель - сбрасываем камеру на центр
            if (controls && customModelSource && customModelSource.nodes.length > 0) {
                 controls.target.set(0, 0, 0);
                 camera.position.set(600, 450, 700);
            }
            
            updateScene();
        } catch(err) { alert('Ошибка чтения файла: ' + err.message); }
    };
    reader.readAsText(file); event.target.value = '';
});

document.getElementById('resetModelBtn').addEventListener('click', () => {
    customModelSource = null; customPoints = null;
    document.getElementById('resetModelBtn').style.display = 'none';
    
    // Возвращаем камеру в дефолт при сбросе
    if (controls) {
         controls.target.set(0, 0, 0);
         camera.position.set(600, 450, 700);
    }
    
    updateScene();
});

['X', 'Y', 'Z'].forEach(axis => {
    const range = document.getElementById(`insRange${axis}`);
    const num = document.getElementById(`insNum${axis}`);
    if(range && num) {
        range.addEventListener('input', (e) => num.value = e.target.value);
        num.addEventListener('input', (e) => range.value = e.target.value);
    }
});

const applyBtn = document.getElementById('applyNodeShiftBtn');
if (applyBtn) {
    applyBtn.addEventListener('click', () => {
        if (selectedNodeIds.length === 0) return;
        
        const nodeId = selectedNodeIds[0];
        const nodeGroup = spiralGroup.getObjectByName(nodeId);
        const sourceNode = customModelSource.nodes.find(n => n.id === nodeId);

        if (nodeGroup && sourceNode) {
            const newX = parseFloat(document.getElementById('insNumX').value) || 0;
            const newY = parseFloat(document.getElementById('insNumY').value) || 0;
            const newZ = parseFloat(document.getElementById('insNumZ').value) || 0;

            nodeGroup.position.set(newX, newY, newZ);
            
            sourceNode.x = newX;
            sourceNode.y = newY;
            sourceNode.z = newZ;
            
            updateScene(); 
        }
    });
}

window.onload = init3D;