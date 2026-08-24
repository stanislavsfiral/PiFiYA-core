import * as THREE from 'three';

// --- ГЕНЕРАЦИЯ ПРАВОГО ВИТКА СФИРАЛИ ---
export function generateRightBranch(R, H) {
    const mainPts = [];
    const junctionZ = H / 5;
    for (let i = 0; i <= 100; i++) {
        let t = i / 100;
        let angle = 2 * Math.PI * t;
        let x = R * Math.cos(angle);
        let y = R * Math.sin(angle);
        let z = junctionZ + (H - junctionZ) * (1 - t);
        mainPts.push(new THREE.Vector3(x, y, z));
    }
    const sPts = [];
    let r_s = R / 2;
    for (let i = 0; i <= 60; i++) {
        let t = i / 60;
        let angle = Math.PI * t;
        let x = r_s + r_s * Math.cos(angle);
        let y = r_s * Math.sin(angle);
        let z = junctionZ * (1 - t);
        sPts.push(new THREE.Vector3(x, y, z));
    }
    return { mainPts, sPts };
}

// --- ТРОИЧНЫЙ ПРОСТРАНСТВЕННЫЙ АЛГОРИТМ УОЛША С ДВУХУРОВНЕВОЙ СУПЕРПОЗИЦИЕЙ ---
export class TernarySpatialWalshEngine {
    constructor() {
        this.active = false;
    }
    
    quantizeTernary(val) {
        const threshold = 0.3;
        if (Math.abs(val) < threshold) return 0;  
        return val > 0 ? 1 : -1;                  
    }

    // Уровень 1: Оценка внутренней S-петли узла
    evaluateNode(node, time) {
        let pX = Math.sin(time + node.x * 0.02);
        let pY = Math.sin(time + node.y * 0.02 + Math.PI / 3);
        let pZ = Math.sin(time + node.z * 0.02 + Math.PI / 1.5);

        let tensorVal = (pX + pY + pZ) / 3;
        let ternaryState = this.quantizeTernary(tensorVal);

        // Учитываем ориентацию S-петли и углы поворота
        const angleZ = node.params.angles ? node.params.angles[2] : 90;
        const phaseShift = THREE.MathUtils.degToRad(angleZ) * 0.5;

        if (ternaryState === 1) {
            node.params.showRight = true;
            node.params.showS = true;
            node.params.showLeft = false;
            node.params.showSLeft = false;
        } else if (ternaryState === -1) {
            node.params.showRight = false;
            node.params.showS = false;
            node.params.showLeft = true;
            node.params.showSLeft = true;
        } else {
            // Уровень суперпозиции (S-петля как нулевой хроноквант)
            node.params.showRight = true;
            node.params.showS = true;
            node.params.showLeft = true;
            node.params.showSLeft = true;
        }
        
        node.quantumState = {
            intensity: Math.abs(tensorVal),
            psi_real: pX * Math.cos(phaseShift),
            psi_imag: pY * Math.sin(phaseShift)
        };
    }

    // Уровень 2: Оценка суперпозиции между Сфиралями через общий виток (с учетом поворота на 180° по Y и Z)
    evaluateChainBridge(nodeA, nodeB) {
        let dx = nodeA.x - nodeB.x;
        let dy = nodeA.y - nodeB.y;
        let dz = nodeA.z - nodeB.z;
        let distance = Math.sqrt(dx*dx + dy*dy + dz*dz);

        // Проверяем взаимный поворот на 180 градусов по осям Y и Z
        const anglesA = nodeA.params.angles || [180, 0, 90];
        const anglesB = nodeB.params.angles || [180, 0, 90];
        
        let diffY = Math.abs(anglesA[1] - anglesB[1]);
        let diffZ = Math.abs(anglesA[2] - anglesB[2]);
        let isReversed180 = (Math.abs(diffY - 180) < 15 && Math.abs(diffZ - 180) < 15);

        // Если расстояние меньше порога сопряжения, формируется общий виток-мост
        const thresholdBridge = 120 * ((nodeA.params.scale + nodeB.params.scale) / 2);
        
        if (distance <= thresholdBridge) {
            // Чередование хиральности общего витка (левый/правый) при развороте на 180°
            let bridgeChirality = isReversed180 ? -1 : 1;
            let superpositionWeight = 1.0 - (distance / thresholdBridge);

            return {
                isBridge: true,
                chirality: bridgeChirality,
                weight: superpositionWeight,
                sharedState: true
            };
        }

        return { isBridge: false, chirality: 0, weight: 0, sharedState: false };
    }
}