export function generateSphiralTopology(R = 140, H = 190) {
    let junctionZ = H / 5.0; // Зона плавной деформации
    let r_s = R / 2.0;

    // 1. Левый основной виток (вытягивается в положительном направлении по высоте: +H)
    let leftMainX = [], leftMainY = [], leftMainZ = [];
    for (let i = 0; i <= 100; i++) {
        let t = i / 100.0;
        let angle = 2 * Math.PI * t;
        leftMainX.push(R * Math.cos(angle));
        leftMainY.push(R * Math.sin(angle));
        // ИСПРАВЛЕНО: Конечная координата витка идеально сходится с началом S-петли
        leftMainZ.push(junctionZ + (H - junctionZ) * (1 - t)); 
    }

    // 2. Левый малый полувиток масштаба 0.5 (часть S-петли)
    let leftHalfX = [], leftHalfY = [], leftHalfZ = [];
    for (let i = 0; i <= 60; i++) {
        let t = i / 60.0;
        let angle = Math.PI * t;
        leftHalfX.push(r_s + r_s * Math.cos(angle));
        leftHalfY.push(r_s * Math.sin(angle));
        leftHalfZ.push(junctionZ * (1 - t));
    }

    // 3. Правый малый полувиток масштаба 0.5 (антипод с поворотом на 180° по оси X)
    let rightHalfX = [], rightHalfY = [], rightHalfZ = [];
    for (let i = 0; i <= 60; i++) {
        let t = i / 60.0;
        let angle = Math.PI * t;
        rightHalfX.push(-(r_s + r_s * Math.cos(angle)));
        rightHalfY.push(-(r_s * Math.sin(angle)));
        rightHalfZ.push(-junctionZ * (1 - t));
    }

    // 4. Правый основной виток (зеркальный антипод, вытягивается в противоположном направлении: -H)
    let rightMainX = [], rightMainY = [], rightMainZ = [];
    for (let i = 0; i <= 100; i++) {
        let t = i / 100.0;
        let angle = 2 * Math.PI * t;
        rightMainX.push(-R * Math.cos(angle));
        rightMainY.push(-R * Math.sin(angle));
        // ИСПРАВЛЕНО: Сшивка с антисимметричным полувитком
        rightMainZ.push(-junctionZ - (H - junctionZ) * (1 - t)); 
    }

    return {
        left: { main: { x: leftMainX, y: leftMainY, z: leftMainZ }, half: { x: leftHalfX, y: leftHalfY, z: leftHalfZ } },
        right: { main: { x: rightMainX, y: rightMainY, z: rightMainZ }, half: { x: rightHalfX, y: rightHalfY, z: rightHalfZ } }
    };
}

// Обратная совместимость для старых вызовов точек
export function generateHalfPoints(R = 140, H = 190) {
    let topo = generateSphiralTopology(R, H);
    return {
        x: topo.left.main.x.concat(topo.left.half.x),
        y: topo.left.main.y.concat(topo.left.half.y),
        z: topo.left.main.z.concat(topo.left.half.z)
    };
}

export class GideonWebCore {
    constructor() {
        this.states = [-1, 0, 1];
    }

    applyHadamard(packet, modeFlag) {
        return packet.map(p => p * (modeFlag ? -1 : 1));
    }

    // Оператор S-перехода с учетом ламинарной инверсии и поворота на 180° по оси X
    sTransitionOperator(s1, s2, mode) {
        let sum = s1 + s2;
        if (mode === 'Axis X') {
            return [s1 === s2 ? 0 : -s2, s1 === s2 ? 0 : -s1];
        } else if (mode === 'Axis Y') {
            let circ = (s1 + s2 === 0) ? 1 : (s1 > s2 ? -1 : 1);
            return [Math.round(s1 * 0.5), -circ];
        } else if (mode === 'Axis Z') {
            if (sum === 0 && s1 !== 0) return [s1, s2];
            return [Math.max(-1, Math.min(1, s2)), Math.max(-1, Math.min(1, s1))];
        } else {
            if (sum === 0 && s1 !== 0) return [-s1, -s2];
            let factor = Math.abs(sum) > 0 ? 2.0 : 1.0;
            // Учет пространственной инверсии второго потока (-s2)
            return [
                Math.round(Math.max(-1, Math.min(1, s1 * factor))), 
                Math.round(Math.max(-1, Math.min(1, -s2 * factor)))
            ];
        }
    }

    routeChiralStream(streamA, streamB, chiralitySign, mode) {
        if (mode === 'Axis Y') {
            return [streamA, streamB];
        }
        // Строгая зеркальная антисимметрия хиральностей витков-антиподов
        let routedA = streamA.map(a => a * chiralitySign);
        let routedB = streamB.map(b => b * (-chiralitySign)); 
        return [routedA, routedB];
    }

    processStream(packetA, packetB, nCores, mode, harmAxis) {
        let results = {};
        let angleStep = 360.0 / nCores;
        let encodedA = this.applyHadamard(packetA, mode !== 'Single');
        let encodedB = this.applyHadamard(packetB, mode !== 'Single');

        for (let k = 0; k < nCores; k++) {
            let angleK = k * angleStep;
            let radK = angleK * Math.PI / 180.0;
            let scaleN = 1.0 + (k % Math.max(1, nCores)) / Math.max(1, nCores);

            let fieldFactor = Math.sin(radK * scaleN);
            if (harmAxis === 'Harmonic Y') fieldFactor = Math.cos(radK * scaleN);
            if (harmAxis === 'Harmonic Z') fieldFactor = Math.sin(radK * scaleN) - Math.cos(radK);

            let resA = [], resB = [];
            for (let i = 0; i < encodedA.length; i++) {
                let [outA, outB] = this.sTransitionOperator(encodedA[i], encodedB[i], mode);
                resA.push(outA + Math.round(fieldFactor * 0.2));
                resB.push(outB - Math.round(fieldFactor * 0.2));
            }

            let chiralitySign = (k % 2 === 0) ? 1 : -1;
            let [routedA, routedB] = this.routeChiralStream(resA, resB, chiralitySign, mode);
            results[`Модуль ${k+1} (${angleK.toFixed(0)}°)`] = { a: routedA, b: routedB };
        }
        return results;
    }

    calculateAdamBalance(origPacket, resultsObj, mode, quenchRate) {
        let coreKeys = Object.keys(resultsObj);
        if (coreKeys.length === 0) return 0;
        let transStream = resultsObj[coreKeys[0]].a;

        let diffSum = 0, count = 0;
        for (let i = 0; i < Math.min(origPacket.length, transStream.length); i++) {
            diffSum += Math.abs(origPacket[i] - transStream[i]);
            count++;
        }
        let meanDiff = count > 0 ? diffSum / count : 0;

        if (mode === 'Axis X') return meanDiff * (0.8 / Math.sqrt(quenchRate));
        else if (mode === 'Axis Y') return meanDiff * (1.2 / (quenchRate + 0.1));
        else return meanDiff * (1.0 / Math.sqrt(quenchRate));
    }
}

// ==========================================
// АВТОНОМНОЕ КВАНТОВОЕ ЯДРО (JS)
// ==========================================
class Complex {
    constructor(re = 0, im = 0) { this.re = re; this.im = im; }
    add(c) { return new Complex(this.re + c.re, this.im + c.im); }
    mul(c) { return new Complex(this.re * c.re - this.im * c.im, this.re * c.im + this.im * c.re); }
    mag2() { return this.re * this.re + this.im * this.im; }
    scale(s) { return new Complex(this.re * s, this.im * s); }
}

function dot3x3(matrix, vector) {
    let res = [new Complex(), new Complex(), new Complex()];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) res[i] = res[i].add(matrix[i][j].mul(vector[j]));
    }
    return res;
}

const S_JUNCTION = [
    [new Complex(0), new Complex(0), new Complex(1)],
    [new Complex(0), new Complex(1), new Complex(0)],
    [new Complex(1), new Complex(0), new Complex(0)]
];
const hF = 1 / Math.sqrt(3);
const w = new Complex(-0.5, Math.sqrt(3)/2);
const w2 = new Complex(-0.5, -Math.sqrt(3)/2);
const HADAMARD = [
    [new Complex(hF), new Complex(hF), new Complex(hF)],
    [new Complex(hF), w.scale(hF), w2.scale(hF)],
    [new Complex(hF), w2.scale(hF), w.scale(hF)]
];

export class SfiralQutrit {
    constructor(L = 0, S = 0, R = 1) {
        this.state = [new Complex(L), new Complex(S), new Complex(R)];
        this.normalize();
    }
    normalize() {
        let norm = Math.sqrt(this.state[0].mag2() + this.state[1].mag2() + this.state[2].mag2());
        if (norm > 0) this.state = this.state.map(c => c.scale(1/norm));
    }
    applyGate(gateName) {
        let matrix = gateName === 'SCALE_CORRECTOR' ? S_JUNCTION : HADAMARD;
        this.state = dot3x3(matrix, this.state);
        this.normalize();
    }
    add(other) {
        this.state = [this.state[0].add(other.state[0]), this.state[1].add(other.state[1]), this.state[2].add(other.state[2])];
        this.normalize();
    }
    getProbabilities() {
        return { L: parseFloat(this.state[0].mag2().toFixed(4)), S: parseFloat(this.state[1].mag2().toFixed(4)), R: parseFloat(this.state[2].mag2().toFixed(4)) };
    }
    clone() {
        let q = new SfiralQutrit();
        q.state = [new Complex(this.state[0].re, this.state[0].im), new Complex(this.state[1].re, this.state[1].im), new Complex(this.state[2].re, this.state[2].im)];
        return q;
    }
}

export function computeQuantumNetwork(nodes, edges) {
    let quantum_results_map = {};
    let start_nodes = nodes.filter(n => !edges.some(e => e.to === n.id)).map(n => n.id);
    if (start_nodes.length === 0 && nodes.length > 0) start_nodes = [nodes[0].id];

    let active_signals = {};
    start_nodes.forEach(id => { active_signals[id] = new SfiralQutrit(0, 0, 1); });
    let nodesMap = {}; nodes.forEach(n => nodesMap[n.id] = n);

    for (let tick = 0; tick < nodes.length + 5; tick++) {
        if (Object.keys(active_signals).length === 0) break;
        let next_signals = {};

        for (let curr_id in active_signals) {
            curr_id = Number(curr_id);
            if (!nodesMap[curr_id]) continue;
            
            let qutrit = active_signals[curr_id];
            let gate_type = nodesMap[curr_id].params?.activeGate || 'ROUTER_SWAP';
            if (gate_type === 'ROUTER_SWAP' || gate_type === 'SCALE_CORRECTOR') qutrit.applyGate(gate_type);

            quantum_results_map[curr_id] = { id: curr_id, qutrit_state: qutrit.getProbabilities(), activeGate: gate_type };

            edges.filter(e => e.from === curr_id).forEach(edge => {
                let prop = qutrit.clone();
                if (next_signals[edge.to]) next_signals[edge.to].add(prop);
                else next_signals[edge.to] = prop;
            });
        }
        active_signals = next_signals;
    }
    return Object.values(quantum_results_map);
}