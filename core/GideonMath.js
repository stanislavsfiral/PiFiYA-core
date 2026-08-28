export function generateSphiralTopology(R = 140, H = 190) {
    // 1. Левый основной виток (вытягивается в положительном направлении по высоте: +H)
    let leftMainX = [], leftMainY = [], leftMainZ = [];
    for (let i = 0; i <= 100; i++) {
        let t = i / 100.0;
        let angle = 2 * Math.PI * t;
        leftMainX.push(R * Math.cos(angle));
        leftMainY.push(R * Math.sin(angle));
        leftMainZ.push(H * (1 - t));
    }

    // 2. Левый малый полувиток масштаба 0.5 (часть S-петли)
    let r_s = R / 2.0;
    let leftHalfX = [], leftHalfY = [], leftHalfZ = [];
    let junctionZ = H / 5.0;
    for (let i = 0; i <= 60; i++) {
        let t = i / 60.0;
        let angle = Math.PI * t;
        leftHalfX.push(r_s + r_s * Math.cos(angle));
        leftHalfY.push(r_s * Math.sin(angle));
        leftHalfZ.push(junctionZ * (1 - t));
    }

    // 3. Правый малый полувиток масштаба 0.5 (антипод с поворотом на 180° по оси X)
    // При повороте на 180° по X: X без изменений, Y -> -Y, Z -> -Z
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
        rightMainZ.push(-H * (1 - t)); // Противофазное вытягивание по высоте вниз (-H)
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