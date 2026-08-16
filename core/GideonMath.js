export function generateHalfPoints(R = 140, H = 190) {
    let ptsX = [], ptsY = [], ptsZ = [];
    let junctionZ = H / 5.0;

    for (let i = 0; i <= 100; i++) {
        let t = i / 100.0;
        let angle = 2 * Math.PI * t;
        ptsX.push(R * Math.cos(angle));
        ptsY.push(R * Math.sin(angle));
        ptsZ.push(junctionZ + (H - junctionZ) * (1 - t));
    }

    let r_s = R / 2.0;
    for (let i = 0; i <= 60; i++) {
        let t = i / 60.0;
        let angle = Math.PI * t;
        ptsX.push(r_s + r_s * Math.cos(angle));
        ptsY.push(r_s * Math.sin(angle));
        ptsZ.push(junctionZ * (1 - t));
    }
    return { x: ptsX, y: ptsY, z: ptsZ };
}

export class GideonWebCore {
    constructor() {
        this.states = [-1, 0, 1];
    }

    applyHadamard(packet, modeFlag) {
        return packet.map(p => p * (modeFlag ? -1 : 1));
    }

    sTransitionOperator(s1, s2, mode) {
        let sum = s1 + s2;
        if (mode === 'Axis X') {
            return [s1 === s2 ? 0 : -s2, s1 === s2 ? 0 : -s1];
        } else if (mode === 'Axis Y') {
            let circ = (s1 + s2 === 0) ? 1 : (s1 > s2 ? -1 : 1);
            return [Math.round(s1 * 0.5), circ];
        } else if (mode === 'Axis Z') {
            if (sum === 0 && s1 !== 0) return [-s1, -s2];
            return [Math.max(-1, Math.min(1, -s2)), Math.max(-1, Math.min(1, -s1))];
        } else {
            if (sum === 0 && s1 !== 0) return [-s1, -s2];
            let factor = Math.abs(sum) > 0 ? 2.0 : 1.0;
            return [Math.round(Math.max(-1, Math.min(1, s1 * factor))), Math.round(Math.max(-1, Math.min(1, s2 * factor)))];
        }
    }

    routeChiralStream(streamA, streamB, chiralitySign, mode) {
        let multiplier = (mode === 'Axis Y') ? 1 : chiralitySign;
        return [streamA.map(a => a * multiplier), streamB.map(b => b * multiplier)];
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