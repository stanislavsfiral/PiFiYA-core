import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { generateHalfPoints, GideonWebCore } from '../core/GideonMath.js?v=dynamic';

let customModelSource = null; 
let customPoints = null;      

let scene, camera, renderer, controls, spiralGroup;
let core = new GideonWebCore();
let globalNodesData = {}; 

const vectorCenter = new THREE.Vector3(0, 0, 0);
const vectorRight = new THREE.Vector3(100, 100, 100);
const vectorLeft = new THREE.Vector3(-100, 100, -100);

const R_sphere = 280.0;
const axisVectors = {
    posX: new THREE.Vector3(R_sphere * 1.15, 0, 0),
    negX: new THREE.Vector3(-R_sphere * 1.15, 0, 0),
    posY: new THREE.Vector3(0, R_sphere * 1.15, 0),
    negY: new THREE.Vector3(0, -R_sphere * 1.15, 0),
    posZ: new THREE.Vector3(0, 0, R_sphere * 1.15),
    negZ: new THREE.Vector3(0, 0, -R_sphere * 1.15)
};

let signalSpheres = [];
let animClock = 0;
let cachedCurvesData = []; 
let onlyResultMode = false;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let lastQuantumResults = []; 

function init3D() {
    const container = document.getElementById('canvasContainer');
    scene = new THREE.Scene();
    
    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 8000);
    camera.position.set(600, 450, 700);

    renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('renderCanvas'), antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0); 
    controls.mouseButtons = { LEFT: THREE.MOUSE.NONE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

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

    updateScene();
    animate();
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
            if (hits.length > 0) {
                intersects.push({ object: group, distance: hits[0].distance });
            }
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
    const graphData = { model_name: "Sfiral_Quantum_Circuit", nodes: nodes, edges: edges || [] };
    let logEl = document.getElementById('consoleLog');
    logEl.innerHTML += `<div class="console-line type-sys">[NETWORK] Отправка топологии на динамическое ядро...</div>`;
    logEl.scrollTop = logEl.scrollHeight;

    try {
        const response = await fetch('http://localhost:8000', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(graphData)
        });

        const result = await response.json();
        
        if (result.status === "success") {
            logEl.innerHTML += `<div class="console-line type-qcore">⚡ [Q-CORE] Вычисление завершено за ${result.execution_time_ms}мс. Интерференция просчитана.</div>`;
            lastQuantumResults = result.nodes_quantum;

            spiralGroup.children.forEach(group => {
                if (group.type === 'Group' && group.children.length >= 3) {
                    group.children[0].material.opacity = 0.1;
                    group.children[1].material.opacity = 0.1;
                    group.children[2].material.opacity = 0.1;
                    group.children[0].material.color.setHex(0x002244);
                    group.children[1].material.color.setHex(0x444400);
                    group.children[2].material.color.setHex(0x440011);
                }
            });
            Object.values(globalNodesData).forEach(nodeData => {
                if(nodeData.sphereMesh) nodeData.sphereMesh.visible = false;
            });

            result.nodes_quantum.forEach(qNode => {
                const group = spiralGroup.getObjectByName(qNode.id);
                const nodeData = globalNodesData[qNode.id];

                if (group && group.children.length >= 3) {
                    let rMat = group.children[0].material; 
                    let sMat = group.children[1].material; 
                    let lMat = group.children[2].material; 

                    let pR = qNode.qutrit_state.R;
                    let pS = qNode.qutrit_state.S;
                    let pL = qNode.qutrit_state.L;
                    let totalEnergy = pR + pS + pL;

                    rMat.opacity = 0.25 + 0.75 * pR;
                    sMat.opacity = 0.25 + 0.75 * pS;
                    lMat.opacity = 0.25 + 0.75 * pL;
                    
                    rMat.color.setHex(pR > 0.05 ? 0x00e5ff : 0x004477);
                    sMat.color.setHex(pS > 0.05 ? 0xffe600 : 0x888800);
                    lMat.color.setHex(pL > 0.05 ? 0xff3366 : 0x880022);

                    if (totalEnergy > 0.05 && nodeData && nodeData.sphereMesh) {
                        nodeData.sphereMesh.visible = true;
                        let scale = 1.0 + totalEnergy * 0.5; 
                        nodeData.sphereMesh.scale.set(scale, scale, scale);
                        
                        if (pR >= pL && pR >= pS) nodeData.sphereMesh.material.color.setHex(0x00e5ff);
                        else if (pL >= pR && pL >= pS) nodeData.sphereMesh.material.color.setHex(0xff3366);
                        else nodeData.sphereMesh.material.color.setHex(0xffe600);
                    }
                }
            });
            logEl.scrollTop = logEl.scrollHeight;
        }
    } catch (error) {
        console.error("❌ Ошибка связи с квантовым ядром:", error);
        logEl.innerHTML += `<div class="console-line type-err">[ERROR] Сервер недоступен (localhost:8000)</div>`;
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

        let ex = 90, ez = 120;
        if (customModelSource.nodes.length > 0 && customModelSource.nodes[0].entryPoint) {
            ex = Math.abs(customModelSource.nodes[0].entryPoint.x);
            ez = Math.abs(customModelSource.nodes[0].entryPoint.z);
        }
        
        const basePtsObj = generateHalfPoints(ex, ez);
        
        // --- ДИНАМИЧЕСКОЕ ВЫЧИСЛЕНИЕ S-ПЕРЕХОДА ---
        let splitIdx = Math.floor(basePtsObj.x.length * 0.62); 
        if (basePtsObj.x.length > 0) {
            let r0 = Math.sqrt(basePtsObj.x[0]**2 + basePtsObj.y[0]**2);
            for(let i=0; i<basePtsObj.x.length; i++) {
                let r = Math.sqrt(basePtsObj.x[i]**2 + basePtsObj.y[i]**2);
                if (r0 - r > 1.0) { splitIdx = Math.max(0, i - 1); break; }
            }
        }
        // ------------------------------------------

        let fullPts = [];
        for(let i=0; i<basePtsObj.x.length; i++) {
            fullPts.push(new THREE.Vector3(basePtsObj.x[i], basePtsObj.y[i], basePtsObj.z[i]));
        }
        let aPts = fullPts.map(p => new THREE.Vector3(-p.x, -p.y, -p.z));
        
        let flowRightToLeft = [];
        for(let i=0; i<fullPts.length; i++) { flowRightToLeft.push(fullPts[i].clone()); }
        for(let i=fullPts.length-1; i>=0; i--) { flowRightToLeft.push(new THREE.Vector3(-fullPts[i].x, -fullPts[i].y, -fullPts[i].z)); }

        customModelSource.nodes.forEach(node => {
            const nodeGroup = new THREE.Group();
            nodeGroup.name = node.id; 
            
            let px = node.x !== undefined ? node.x : (node.position ? node.position.x : 0);
            let py = node.y !== undefined ? node.y : (node.position ? node.position.y : 0);
            let pz = node.z !== undefined ? node.z : (node.position ? node.position.z : 0);
            nodeGroup.position.set(px, py, pz);

            const angles = (node.params && node.params.angles) ? node.params.angles : [0, 0, 0];
            const euler = new THREE.Euler(
                THREE.MathUtils.degToRad(angles[0]),
                THREE.MathUtils.degToRad(angles[1]),
                THREE.MathUtils.degToRad(angles[2])
            );
            nodeGroup.rotation.copy(euler);

            // Идеальная бесшовная нарезка JSON-графа
            const rightPts = fullPts.slice(0, splitIdx + 1);
            const leftPts = aPts.slice(0, splitIdx + 1).reverse();
            const sPts = fullPts.slice(splitIdx);
            for(let i = aPts.length - 2; i >= splitIdx; i--) sPts.push(aPts[i]);

            nodeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPts), new THREE.LineBasicMaterial({ color: 0x00a0ff, transparent: true, opacity: 1.0 })));
            nodeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sPts), new THREE.LineBasicMaterial({ color: 0xffe600, transparent: true, opacity: 1.0 })));
            nodeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPts), new THREE.LineBasicMaterial({ color: 0xff4444, transparent: true, opacity: 1.0 })));
            
            let centerMesh = new THREE.Mesh(new THREE.SphereGeometry(2, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
            nodeGroup.add(centerMesh);

            spiralGroup.add(nodeGroup);

            const pos = new THREE.Vector3(px, py, pz);
            let worldPath = flowRightToLeft.map(p => p.clone().applyEuler(euler).add(pos));

            let sphereMesh = new THREE.Mesh(new THREE.SphereGeometry(2.5, 16, 16), new THREE.MeshBasicMaterial({ color: 0x00ffcc }));
            sphereMesh.visible = false; 
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
                        spiralGroup.add(new THREE.Line(
                            new THREE.BufferGeometry().setFromPoints(pts), 
                            new THREE.LineBasicMaterial({ color: 0x4466aa, transparent: true, opacity: 0.5, linewidth: 2 })
                        ));
                    }
                }
            });
        }
        
        const box = new THREE.Box3().setFromObject(spiralGroup);
        const center = new THREE.Vector3();
        box.getCenter(center);
        
        controls.target.copy(center);
        camera.position.set(center.x + 600, center.y + 450, center.z + 700);
        controls.update();

        computeQuantumState(customModelSource.nodes, customModelSource.edges);

    } else {
        // БАЗОВЫЙ РЕЖИМ (Сфираль / Диполь / Звезда)
        document.getElementById('statusHeader').innerText = "STATUS: ACTIVE • Q-ZERO CHIRALITY";
        document.getElementById('resetModelBtn').style.display = customPoints ? 'block' : 'none';

        controls.target.set(0, 0, 0);
        camera.position.set(600, 450, 700);
        controls.update();

        let rawStruct = customPoints ? customPoints : generateHalfPoints(140, 190);
        let rawX = rawStruct.x, rawY = rawStruct.y, rawZ = rawStruct.z;

        // --- ДИНАМИЧЕСКОЕ ВЫЧИСЛЕНИЕ S-ПЕРЕХОДА ДЛЯ БАЗЫ ---
        let splitIdx = Math.floor(rawX.length * 0.62);
        if (rawX.length > 0) {
            let r0 = Math.sqrt(rawX[0]**2 + rawY[0]**2);
            for(let i=0; i<rawX.length; i++) {
                let r = Math.sqrt(rawX[i]**2 + rawY[i]**2);
                if (r0 - r > 1.0) { splitIdx = Math.max(0, i - 1); break; }
            }
        }
        // ----------------------------------------------------

        let centerGeo = new THREE.SphereGeometry(2.5, 16, 16);
        spiralGroup.add(new THREE.Mesh(centerGeo, new THREE.MeshBasicMaterial({ color: 0xffe600 })));

        for (let k = 0; k < nCores; k++) {
            let angle = k * angleStep;
            let tPoints = [], aPoints = [];
            for (let i = 0; i < rawX.length; i++) {
                let p1 = rotateCoords(rawX[i], rawY[i], rawZ[i], angle, harmAxis);
                tPoints.push(new THREE.Vector3(p1.x, p1.y, p1.z));
                aPoints.push(new THREE.Vector3(-p1.x, -p1.y, -p1.z));
            }

            if (k === 0) {
                vectorRight.copy(tPoints[15] || tPoints[0]);
                vectorLeft.copy(aPoints[15] || aPoints[0]);
            }

            // Идеальная бесшовная нарезка
            let rightPts = tPoints.slice(0, splitIdx + 1);
            let leftPts = aPoints.slice(0, splitIdx + 1).reverse();
            let sPts = tPoints.slice(splitIdx);
            for(let i = aPoints.length - 2; i >= splitIdx; i--) sPts.push(aPoints[i]);

            spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPts), new THREE.LineBasicMaterial({ color: 0x00e5ff, linewidth: 2, transparent: true, opacity: 0.7 })));
            spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sPts), new THREE.LineBasicMaterial({ color: 0xffe600, linewidth: 2, transparent: true, opacity: 0.7 })));
            spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPts), new THREE.LineBasicMaterial({ color: 0xff3366, linewidth: 2, transparent: true, opacity: 0.7 })));

            cachedCurvesData.push({ points: tPoints, color: 0x00ffff });
            cachedCurvesData.push({ points: aPoints, color: 0xff0055 });

            // ДОПОЛНИТЕЛЬНЫЕ РЕЖИМЫ (РАЗВОРОТЫ)
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

                spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPts2), new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2, transparent: true, opacity: 0.5 })));
                spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sPts2), new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 2, transparent: true, opacity: 0.5 })));
                spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPts2), new THREE.LineBasicMaterial({ color: 0xff8800, linewidth: 2, transparent: true, opacity: 0.5 })));

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
        
        let logEl = document.getElementById('consoleLog');
        if (!onlyResultMode) {
            logEl.innerHTML += `<div class="console-line type-sys">[CORE] Расчет Весов Адама... Формация: ${mode}, Ось: ${harmAxis}</div>`;
        }
        let firstKey = Object.keys(results)[0];
        logEl.innerHTML += `<div class="console-line type-sys" style="color:#00ffaa; font-weight:bold;">[RESULT] Режим: ${mode} | Ядер: ${nCores} | Весы Адама: ${adamBalanceVal.toFixed(4)} | ${firstKey} -> [${results[firstKey].a}]</div>`;
        logEl.scrollTop = logEl.scrollHeight;
    }
}

function updateLabels() {
    const container = document.getElementById('canvasContainer');
    const width = container.clientWidth;
    const height = container.clientHeight;

    let mode = document.getElementById('modeSelect').value;
    let nCores = parseInt(document.getElementById('coresInput').value) || 1;
    let showSpiralLabels = (mode === 'Single' && nCores === 1 && !customPoints && !customModelSource);

    function renderLabel(vector, elementId, show) {
        let el = document.getElementById(elementId);
        if (!show) { el.style.display = 'none'; return; }
        let v = vector.clone().project(camera);
        let x = (v.x * .5 + .5) * width;
        let y = (v.y * -.5 + .5) * height;
        if (v.z < 1) { el.style.display = 'block'; el.style.left = x + 'px'; el.style.top = y + 'px'; } 
        else { el.style.display = 'none'; }
    }
    renderLabel(vectorRight, 'labelRight', showSpiralLabels);
    renderLabel(vectorLeft, 'labelLeft', showSpiralLabels);
    renderLabel(vectorCenter, 'labelCenter', showSpiralLabels);
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
    updateLabels();
}

// ========================================================
// ЭКСПОРТ И ИНТЕРФЕЙС
// ========================================================
document.getElementById('exportJsonBtn')?.addEventListener('click', () => {
    if (!customModelSource) { alert("Нет загруженной кастомной модели."); return; }
    const exportData = { model_name: "Gideon_Exported_Circuit", nodes: customModelSource.nodes, edges: customModelSource.edges };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 4));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "sfiral_circuit_export.json");
    document.body.appendChild(downloadAnchorNode); 
    downloadAnchorNode.click(); downloadAnchorNode.remove();
    document.getElementById('consoleLog').innerHTML += `<div class="console-line type-sys">[SYS] Топология сохранена.</div>`;
});

document.getElementById('exportStlBtn')?.addEventListener('click', () => {
    alert("Для экспорта сплайнов (THREE.Line) в твердотельный STL для 3D-печати необходимо конвертировать их в THREE.TubeGeometry. Функция в разработке.");
});

document.getElementById('calcBtn').addEventListener('click', () => {
    document.getElementById('consoleLog').innerHTML += `<div class="console-line type-sys">[USER ACTION] Принудительный расчет пакетов.</div>`;
    updateScene();
});
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
                document.getElementById('consoleLog').innerHTML += `<div class="console-line type-sys">[SUCCESS] Топология загружена! Узлов: ${data.nodes.length}</div>`;
            }
            document.getElementById('resetModelBtn').style.display = 'block';
            updateScene();
        } catch(err) { alert('Ошибка чтения файла: ' + err.message); }
    };
    reader.readAsText(file); event.target.value = '';
});

document.getElementById('resetModelBtn').addEventListener('click', () => {
    customModelSource = null; customPoints = null;
    document.getElementById('resetModelBtn').style.display = 'none';
    updateScene();
});

function applyRouterConfiguration(mode) { if (customModelSource) updateScene(); }
document.getElementById('btnRouteIsolate')?.addEventListener('click', () => applyRouterConfiguration('isolate'));
document.getElementById('btnRouteDelay')?.addEventListener('click', () => applyRouterConfiguration('delay'));
document.getElementById('btnRoutePairs')?.addEventListener('click', () => applyRouterConfiguration('pairs'));

window.onload = init3D;