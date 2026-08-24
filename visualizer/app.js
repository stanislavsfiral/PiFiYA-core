import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { generateHalfPoints, GideonWebCore } from '../core/GideonMath.js';

let customModelSource = null; 
let customPoints = null;      

let scene, camera, renderer, controls, spiralGroup;
let core = new GideonWebCore();
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

function init3D() {
    const container = document.getElementById('canvasContainer');
    scene = new THREE.Scene();
    
    camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 4000);
    camera.position.set(600, 450, 700);

    renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('renderCanvas'), antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    // Настройка контроллеров камеры: вращение строго вокруг центра по ПРАВОЙ кнопке мыши (ПКМ)
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0); // Фокус вращения в центре модели

    controls.mouseButtons = {
        LEFT: THREE.MOUSE.NONE,     // Левая кнопка не вращает камеру
        MIDDLE: THREE.MOUSE.DOLLY,  // Зум колесиком
        RIGHT: THREE.MOUSE.ROTATE   // Вращение камеры по ПКМ
    };

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    const sphereGeo = new THREE.SphereGeometry(R_sphere, 40, 40);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0x00d2ff, wireframe: true, transparent: true, opacity: 0.04 });
    scene.add(new THREE.Mesh(sphereGeo, sphereMat));

    const theta = linspace(0, 2 * Math.PI, 100);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00d2ff, transparent: true, opacity: 0.25 });
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(theta.map(a => new THREE.Vector3(R_sphere * Math.cos(a), R_sphere * Math.sin(a), 0))), lineMat));
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(theta.map(a => new THREE.Vector3(R_sphere * Math.cos(a), 0, R_sphere * Math.sin(a)))), lineMat));
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(theta.map(a => new THREE.Vector3(0, R_sphere * Math.cos(a), R_sphere * Math.sin(a)))), lineMat));

    spiralGroup = new THREE.Group();
    scene.add(spiralGroup);

    window.addEventListener('resize', onWindowResize);
    updateScene();
    animate();
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

function updateScene() {
    clearGroup(spiralGroup);
    signalSpheres = [];
    cachedCurvesData = [];

    let mode = document.getElementById('modeSelect').value;
    let harmAxis = document.getElementById('harmAxisSelect').value;
    let nCores = parseInt(document.getElementById('coresInput').value) || 1;
    let quenchRate = parseFloat(document.getElementById('quenchInput').value) || 1.0;
    let angleStep = 360.0 / nCores;

    if (customModelSource && customModelSource.nodes) {
        document.getElementById('statusHeader').innerText = `STATUS: ACTIVE • ${customModelSource.nodes.length} NODES`;
        document.getElementById('resetModelBtn').style.display = 'block';

        const basePtsObj = generateHalfPoints(90, 120);
        let fullPts = [];
        for(let i=0; i<basePtsObj.x.length; i++) {
            fullPts.push(new THREE.Vector3(basePtsObj.x[i], basePtsObj.y[i], basePtsObj.z[i]));
        }
        const rightPts = fullPts.slice(0, 101);
        const sPts = fullPts.slice(101, 101+61);
        const leftPts = fullPts.map(p => new THREE.Vector3(-p.x, -p.y, -p.z));

        customModelSource.nodes.forEach(node => {
            const nodeGroup = new THREE.Group();
            nodeGroup.position.set(node.x || 0, node.y || 0, node.z || 0);

            const angles = (node.params && node.params.angles) ? node.params.angles : [0, 0, 0];
            nodeGroup.rotation.set(
                THREE.MathUtils.degToRad(angles[0]),
                THREE.MathUtils.degToRad(angles[1]),
                THREE.MathUtils.degToRad(angles[2])
            );

            nodeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPts), new THREE.LineBasicMaterial({ color: 0x00a0ff, transparent: true, opacity: 0.8 })));
            nodeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(sPts), new THREE.LineBasicMaterial({ color: 0xffe600, transparent: true, opacity: 0.8 })));
            nodeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPts), new THREE.LineBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.8 })));
            nodeGroup.add(new THREE.Mesh(new THREE.SphereGeometry(4, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffaa00 })));

            spiralGroup.add(nodeGroup);

            [rightPts, sPts, leftPts].forEach((pts, idx) => {
                let color = idx === 0 ? 0x00ffcc : idx === 1 ? 0xffea00 : 0xff3366;
                let mesh = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 8), new THREE.MeshBasicMaterial({ color: color }));
                spiralGroup.add(mesh);
                signalSpheres.push({ mesh: mesh, points: pts, parentGroup: nodeGroup, speedOffset: Math.random() });
            });
        });

        if (customModelSource.edges) {
            customModelSource.edges.forEach(edge => {
                let nFrom = customModelSource.nodes.find(n => n.id === edge.from);
                let nTo = customModelSource.nodes.find(n => n.id === edge.to);
                if (nFrom && nTo) {
                    let pts = [new THREE.Vector3(nFrom.x || 0, nFrom.y || 0, nFrom.z || 0), new THREE.Vector3(nTo.x || 0, nTo.y || 0, nTo.z || 0)];
                    spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.5 })));
                }
            });
        }
    } 
    else {
        document.getElementById('statusHeader').innerText = "STATUS: ACTIVE • Q-ZERO CHIRALITY";
        document.getElementById('resetModelBtn').style.display = customPoints ? 'block' : 'none';

        let rawStruct = customPoints ? customPoints : generateHalfPoints(140, 190);
        let rawX = rawStruct.x, rawY = rawStruct.y, rawZ = rawStruct.z;

        let centerGeo = new THREE.SphereGeometry(6, 16, 16);
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

            spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(tPoints), new THREE.LineBasicMaterial({ color: 0x00e5ff, linewidth: 2, transparent: true, opacity: 0.7 })));
            spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(aPoints), new THREE.LineBasicMaterial({ color: 0xff3366, linewidth: 2, transparent: true, opacity: 0.7 })));

            cachedCurvesData.push({ points: tPoints, color: 0x00ffff });
            cachedCurvesData.push({ points: aPoints, color: 0xff0055 });

            if (mode !== 'Single') {
                let t2Points = [], a2Points = [];
                for (let i = 0; i < rawX.length; i++) {
                    let p1 = rotateCoords(rawX[i], rawY[i], rawZ[i], angle, harmAxis);
                    let p2, p3;
                    if (mode === 'Axis X') {
                        p2 = { x: p1.x, y: -p1.y, z: -p1.z };
                        p3 = { x: -p1.x, y: p1.y, z: p1.z };
                    } else if (mode === 'Axis Y') {
                        p2 = { x: -p1.x, y: p1.y, z: -p1.z };
                        p3 = { x: p1.x, y: -p1.y, z: p1.z };
                    } else {
                        p2 = { x: -p1.x, y: -p1.y, z: p1.z };
                        p3 = { x: p1.x, y: p1.y, z: -p1.z };
                    }
                    t2Points.push(new THREE.Vector3(p2.x, p2.y, p2.z));
                    a2Points.push(new THREE.Vector3(p3.x, p3.y, p3.z));
                }
                spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(t2Points), new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2, transparent: true, opacity: 0.5 })));
                spiralGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(a2Points), new THREE.LineBasicMaterial({ color: 0xff8800, linewidth: 2, transparent: true, opacity: 0.5 })));

                cachedCurvesData.push({ points: t2Points, color: 0x55ffaa });
                cachedCurvesData.push({ points: a2Points, color: 0xffaa00 });
            }
        }

        const sphereGeo = new THREE.SphereGeometry(7, 16, 16);
        cachedCurvesData.forEach(curve => {
            let mesh = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color: curve.color }));
            spiralGroup.add(mesh);
            signalSpheres.push({ mesh: mesh, points: curve.points });
        });
    }

    let p1 = [1, 0, -1, 1, 0];
    let p2 = [-1, 1, 0, -1, 1];
    let results = core.processStream(p1, p2, nCores, mode, harmAxis);
    let adamBalanceVal = core.calculateAdamBalance(p1, results, mode, quenchRate);

    document.getElementById('statDefects').innerText = adamBalanceVal.toFixed(4);
    document.getElementById('statChirality').innerText = "0.0 (Нулевая балансировка)";
    document.getElementById('statAngle').innerText = angleStep.toFixed(1) + "°";
    document.getElementById('statHadamard').innerText = mode === 'Single' ? "ОРТОГОНАЛЬНО" : `ДИПОЛЬ (${mode})`;

    let logEl = document.getElementById('consoleLog');
    let firstKey = Object.keys(results)[0];
    let resultString = `[RESULT] Режим: ${mode} | Ядер: ${nCores} | Весы Адама: ${adamBalanceVal.toFixed(4)} | ${firstKey} -> [${results[firstKey].a}]`;
    
    if (!onlyResultMode && !customModelSource) {
        logEl.innerHTML += `<div class="console-line">[CORE] Расчет Весов Адама... Формация: ${mode}, Ось: ${harmAxis}</div>`;
    }
    logEl.innerHTML += `<div class="console-line" style="color:#00ffaa; font-weight:bold;">${resultString}</div>`;
    logEl.scrollTop = logEl.scrollHeight;
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
        if (v.z < 1) {
            el.style.display = 'block';
            el.style.left = x + 'px';
            el.style.top = y + 'px';
        } else {
            el.style.display = 'none';
        }
    }

    renderLabel(vectorRight, 'labelRight', showSpiralLabels);
    renderLabel(vectorLeft, 'labelLeft', showSpiralLabels);
    renderLabel(vectorCenter, 'labelCenter', showSpiralLabels);

    renderLabel(axisVectors.posX, 'axisPosX', true);
    renderLabel(axisVectors.negX, 'axisNegX', true);
    renderLabel(axisVectors.posY, 'axisPosY', true);
    renderLabel(axisVectors.negY, 'axisNegY', true);
    renderLabel(axisVectors.posZ, 'axisPosZ', true);
    renderLabel(axisVectors.negZ, 'axisNegZ', true);
}

function animate() {
    requestAnimationFrame(animate);

    let quenchVal = parseFloat(document.getElementById('quenchInput').value) || 1.0;
    let speedMultiplier = parseFloat(document.getElementById('animSpeedRange').value) || 1.0;
    
    animClock += 0.015 * quenchVal * speedMultiplier;

    if (customModelSource && customModelSource.nodes) {
        signalSpheres.forEach(item => {
            if (item.points && item.points.length > 0) {
                let t = (animClock + (item.speedOffset || 0)) % 1.0;
                let idx = Math.floor(t * (item.points.length - 1));
                let localPt = item.points[idx];
                if (localPt && item.parentGroup) {
                    let worldPt = localPt.clone().applyEuler(item.parentGroup.rotation).add(item.parentGroup.position);
                    item.mesh.position.copy(worldPt);
                }
            }
        });
    } else {
        let smoothT = (1 - Math.cos((animClock % Math.PI * 2))) / 2.0;
        signalSpheres.forEach(item => {
            if (item.points && item.points.length > 0) {
                let idx = Math.floor(smoothT * (item.points.length - 1));
                let pt = item.points[idx];
                if (pt) item.mesh.position.set(pt.x, pt.y, pt.z);
            }
        });
    }

    if (controls) controls.update();
    renderer.render(scene, camera);
    updateLabels();
}

document.getElementById('calcBtn').addEventListener('click', () => {
    document.getElementById('consoleLog').innerHTML += `<div class="console-line" style="color:#ffe600;">[USER ACTION] Принудительный расчет пакетов.</div>`;
    updateScene();
});

document.getElementById('modeSelect').addEventListener('change', updateScene);
document.getElementById('harmAxisSelect').addEventListener('change', updateScene);
document.getElementById('coresInput').addEventListener('change', updateScene);
document.getElementById('quenchInput').addEventListener('change', updateScene);

let consoleCollapsed = false;
document.getElementById('toggleConsoleBtn').addEventListener('click', () => {
    consoleCollapsed = !consoleCollapsed;
    document.getElementById('consoleLog').classList.toggle('collapsed', consoleCollapsed);
    document.getElementById('toggleConsoleBtn').innerText = consoleCollapsed ? 'Развернуть 🔽' : 'Свернуть 🔼';
});

document.getElementById('clearLogBtn').addEventListener('click', () => {
    document.getElementById('consoleLog').innerHTML = '<div class="console-line">[SYSTEM] Лог очищен.</div>';
});

document.getElementById('resultOnlyBtn').addEventListener('click', () => {
    onlyResultMode = !onlyResultMode;
    let btn = document.getElementById('resultOnlyBtn');
    btn.style.borderColor = onlyResultMode ? '#00ffaa' : '#2a3f6d';
    btn.innerText = onlyResultMode ? 'Режим: Только результаты (ВКЛ)' : 'Только результат';
});

document.getElementById('loadModelBtn').addEventListener('click', () => {
    document.getElementById('modelFileInput').click();
});

document.getElementById('modelFileInput').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            
            if (data.nodes && Array.isArray(data.nodes)) {
                customModelSource = data;
                customPoints = null;
                document.getElementById('consoleLog').innerHTML += `<div class="console-line" style="color:#00ffaa;">[SUCCESS] Комплекс "${file.name}" загружен! Узлов: ${data.nodes.length}</div>`;
            } else if (data.x && data.y && data.z && Array.isArray(data.x)) {
                customModelSource = null;
                customPoints = data;
                document.getElementById('consoleLog').innerHTML += `<div class="console-line" style="color:#00ffaa;">[SUCCESS] Сплайн "${file.name}" загружен! Точек: ${data.x.length}</div>`;
            } else {
                throw new Error('Неизвестная структура JSON (нет nodes и нет x,y,z).');
            }

            document.getElementById('resetModelBtn').style.display = 'block';
            updateScene();
        } catch(err) {
            alert('Ошибка чтения файла модели: ' + err.message);
        }
    };
    reader.readAsText(file);
    event.target.value = '';
});

document.getElementById('resetModelBtn').addEventListener('click', () => {
    customModelSource = null;
    customPoints = null;
    document.getElementById('resetModelBtn').style.display = 'none';
    document.getElementById('consoleLog').innerHTML += `<div class="console-line" style="color:#ff88ff;">[SYSTEM] Возврат к базовой Сфирали по умолчанию. Все режимы ядра активны.</div>`;
    updateScene();
});

window.onload = init3D;