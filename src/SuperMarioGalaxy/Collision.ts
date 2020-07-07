
import { vec3, mat4 } from "gl-matrix";
import { SceneObjHolder, ResourceHolder, SceneObj } from "./Main";
import { NameObj } from "./NameObj";
import { KCollisionServer, CheckArrowResult } from "./KCollisionServer";
import { HitSensor } from "./HitSensor";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { ZoneAndLayer, LiveActor, makeMtxTRSFromActor } from "./LiveActor";
import { assertExists, nArray, assert, arrayRemoveIfExist } from "../util";
import { transformVec3Mat4w1, transformVec3Mat4w0, isNearZero, isNearZeroVec3, getMatrixTranslation } from "../MathHelpers";
import { connectToScene } from "./ActorUtil";
import { ViewerRenderInput } from "../viewer";
import { JMapInfoIter } from "./JMapInfo";
import { AABB } from "../Geometry";
import { getDebugOverlayCanvas2D, drawWorldSpaceAABB } from "../DebugJunk";

export class Triangle {
    public collisionParts: CollisionParts | null = null;
    public prismIdx: number | null = null;
    public hitSensor: HitSensor | null = null;
    public pos0 = vec3.create();
    public pos1 = vec3.create();
    public pos2 = vec3.create();
    public faceNormal = vec3.create();

    public getAttributes(): JMapInfoIter | null {
        if (this.prismIdx !== null)
            return this.collisionParts!.collisionServer.getAttributes(this.prismIdx);
        else
            return null;
    }

    public copy(other: Triangle): void {
        this.collisionParts = other.collisionParts;
        this.prismIdx = other.prismIdx;
        this.hitSensor = other.hitSensor;
        vec3.copy(this.pos0, other.pos0);
        vec3.copy(this.pos1, other.pos1);
        vec3.copy(this.pos2, other.pos2);
        vec3.copy(this.faceNormal, other.faceNormal);
    }

    public fillData(collisionParts: CollisionParts, prismIdx: number, hitSensor: HitSensor): void {
        this.collisionParts = collisionParts;
        this.prismIdx = prismIdx;
        this.hitSensor = hitSensor;

        const server = collisionParts.collisionServer;
        const prismData = server.getPrismData(prismIdx);

        server.getPos(this.pos0, prismData, 0);
        transformVec3Mat4w1(this.pos0, collisionParts.worldMtx, this.pos0);
        server.getPos(this.pos1, prismData, 1);
        transformVec3Mat4w1(this.pos1, collisionParts.worldMtx, this.pos1);
        server.getPos(this.pos2, prismData, 2);
        transformVec3Mat4w1(this.pos2, collisionParts.worldMtx, this.pos2);
        server.getFaceNormal(this.faceNormal, prismData);
        transformVec3Mat4w0(this.faceNormal, collisionParts.worldMtx, this.faceNormal);
    }
}

export class HitInfo extends Triangle {
    public strikeLoc = vec3.create();
    public distance: number = -1;
}

export const enum Category {
    Map = 0,
    Sunshade = 1,
    WaterSurface = 2,
    MoveLimit = 3,
}

export class TriangleFilterBase {
    public isInvalidTriangle(triangle: Triangle): boolean {
        return false;
    }
}

export class CollisionPartsFilterBase {
    public isInvalidParts(parts: CollisionParts): boolean {
        return false;
    }
}

function getAvgScale(v: vec3): number {
    return (v[0] + v[1] + v[2]) / 3.0;
}

const scratchVec3a = vec3.create();
const scratchVec3b = vec3.create();
export class CollisionParts {
    public validated: boolean = false;
    public hostMtx: mat4 | null = null;

    public collisionServer: KCollisionServer;
    public newWorldMtx = mat4.create();
    public invWorldMtx = mat4.create();
    public worldMtx = mat4.create();
    public oldWorldMtx = mat4.create();
    public notMovedCounter = 0;

    private collisionZone: CollisionZone;
    private checkArrowResult = new CheckArrowResult();

    private scale = 0.0;
    public boundingSphereRadius: number = 0.0;

    private setUpdateMtx = true;
    private setUpdateMtxOneTime = false;

    constructor(sceneObjHolder: SceneObjHolder, zoneAndLayer: ZoneAndLayer, initialHostMtx: mat4, public hitSensor: HitSensor, kclData: ArrayBufferSlice, paData: ArrayBufferSlice | null, public keeperIdx: number, private scaleType: CollisionScaleType) {
        this.collisionServer = new KCollisionServer(kclData, paData);

        sceneObjHolder.create(SceneObj.CollisionDirector);
        const director = assertExists(sceneObjHolder.collisionDirector);
        this.collisionZone = director.keepers[keeperIdx].getZone(zoneAndLayer.zoneId);

        this.resetAllMtx(initialHostMtx);
        this.collisionServer.calcFarthestVertexDistance();

        mat4.getScaling(scratchVec3a, initialHostMtx);
        this.updateBoundingSphereRangeFromScaleVector(scratchVec3a);
    }

    public getTrans(dst: vec3): void {
        getMatrixTranslation(dst, this.worldMtx);
    }

    public setMtxFromHost(): void {
        mat4.copy(this.newWorldMtx, this.hostMtx!);
    }

    public setMtx(m: mat4): void {
        mat4.copy(this.newWorldMtx, m);
    }

    public updateMtx(): void {
        const notMoved = !mat4.equals(this.newWorldMtx, this.worldMtx);

        if (this.setUpdateMtx || this.setUpdateMtxOneTime) {
            if (notMoved) {
                this.notMovedCounter++;
            } else {
                // Matrices are different, update the notMovedCounter.
                this.notMovedCounter = 0;
                if (this.setUpdateMtxOneTime)
                    this.notMovedCounter = 1;

                const scale = this.makeEqualScale(this.newWorldMtx);
                if (isNearZero(scale - this.scale, 0.001))
                    this.updateBoundingSphereRangePrivate(scale);
            }

            this.setUpdateMtxOneTime = false;

            if (this.notMovedCounter < 2) {
                mat4.copy(this.oldWorldMtx, this.worldMtx);
                mat4.copy(this.worldMtx, this.newWorldMtx);
                mat4.invert(this.invWorldMtx, this.worldMtx);
            }
        } else {
            if (notMoved)
                this.notMovedCounter++;
        }
    }

    public forceResetAllMtxAndSetUpdateMtxOneTime(): void {
        mat4.copy(scratchMatrix, this.hostMtx!);
        this.makeEqualScale(scratchMatrix);
        this.resetAllMtxPrivate(scratchMatrix);
        this.setUpdateMtxOneTime = true;
    }

    public addToBelongZone(sceneObjHolder: SceneObjHolder): void {
        sceneObjHolder.collisionDirector!.keepers[this.keeperIdx].addToZone(this, this.collisionZone.zoneId);
    }

    public removeFromBelongZone(sceneObjHolder: SceneObjHolder): void {
        sceneObjHolder.collisionDirector!.keepers[this.keeperIdx].removeFromZone(this, this.collisionZone.zoneId);
    }

    private makeEqualScale(mtx: mat4): number {
        if (this.scaleType === CollisionScaleType.AutoScale) {
            // Nothing to do; leave alone.
            return 1.0;
        }

        mat4.getScaling(scratchVec3a, mtx);
        const scaleXY = scratchVec3a[0] - scratchVec3a[1];
        const scaleZX = scratchVec3a[2] - scratchVec3a[0];
        const scaleYZ = scratchVec3a[1] - scratchVec3a[2];

        if (isNearZero(scaleXY, 0.001) && isNearZero(scaleZX, 0.001) && isNearZero(scaleYZ, 0.001))
            return scratchVec3a[0];

        let scale: number;
        if (this.scaleType === CollisionScaleType.NotUsingScale) {
            // Invert the scale.
            scale = 1.0;
        } else if (this.scaleType === CollisionScaleType.AutoEqualScale) {
            // Equalize the scale.
            scale = getAvgScale(scratchVec3a);
        } else {
            throw "whoops";
        }

        vec3.set(scratchVec3a, scale / scratchVec3a[0], scale / scratchVec3a[1], scale / scratchVec3a[2]);
        mat4.scale(mtx, mtx, scratchVec3a);
        return scale;
    }

    private updateBoundingSphereRangePrivate(scale: number): void {
        this.scale = scale;
        this.boundingSphereRadius = this.collisionServer.farthestVertexDistance;
    }

    public updateBoundingSphereRangeFromScaleVector(scaleVec: vec3): void {
        this.updateBoundingSphereRangePrivate(getAvgScale(scaleVec));
    }

    public updateBoundingSphereRangeFromHostMtx(): void {
        this.updateBoundingSphereRangePrivate(this.makeEqualScale(this.hostMtx!));
    }

    private resetAllMtxPrivate(hostMtx: mat4): void {
        mat4.copy(this.newWorldMtx, hostMtx);
        mat4.copy(this.oldWorldMtx, hostMtx);
        mat4.copy(this.worldMtx, hostMtx);
        mat4.invert(this.invWorldMtx, hostMtx);
    }

    public resetAllMtx(hostMtx: mat4): void {
        this.resetAllMtxPrivate(hostMtx);
    }

    public resetAllMtxFromHost(): void {
        mat4.copy(scratchMatrix, assertExists(this.hostMtx));
        this.makeEqualScale(scratchMatrix);
        this.resetAllMtxPrivate(scratchMatrix);
    }

    public checkStrikeLine(hitInfo: HitInfo[], dstIdx: number, p0: vec3, pDir: vec3, triFilter: TriangleFilterBase | null): number {
        transformVec3Mat4w1(scratchVec3a, this.invWorldMtx, p0);
        transformVec3Mat4w0(scratchVec3b, this.invWorldMtx, pDir);
        this.checkArrowResult.reset();
        this.collisionServer.checkArrow(this.checkArrowResult, hitInfo.length, scratchVec3a, scratchVec3b);

        const dstIdxStart: number = dstIdx;
        for (let i = 0; i < hitInfo.length; i++) {
            const prism = this.checkArrowResult.prisms[i];
            if (prism === null)
                break;

            const prismIdx = this.collisionServer.toIndex(prism);
            hitInfo[dstIdx].fillData(this, prismIdx, this.hitSensor);
            if (triFilter !== null && triFilter.isInvalidTriangle(hitInfo[dstIdx]))
                continue;

            const dist = this.checkArrowResult.distances[i]!;
            vec3.scaleAndAdd(hitInfo[dstIdx].strikeLoc, scratchVec3a, scratchVec3b, dist);
            transformVec3Mat4w1(hitInfo[dstIdx].strikeLoc, this.worldMtx, hitInfo[dstIdx].strikeLoc);
            hitInfo[dstIdx].distance = dist;
            dstIdx++;
        }
        return dstIdx - dstIdxStart;
    }
}

function isInRange(v: number, v0: number, v1: number): boolean {
    const min = Math.min(v0, v1), max = Math.max(v0, v1);
    return v >= min && v <= max;
}

class CollisionZone {
    public boundingSphereCenter: vec3 | null = null;
    public boundingSphereRadius: number | null = null;
    public boundingAABB: AABB | null = null;
    public parts: CollisionParts[] = [];

    constructor(public zoneId: number) {
        if (this.zoneId > 0) {
            this.boundingSphereCenter = vec3.create();
            this.boundingSphereRadius = -1;
            this.boundingAABB = new AABB();
        }
    }

    public addParts(parts: CollisionParts): void {
        this.parts.push(parts);

        if (this.calcMinMaxAddParts(parts))
            this.calcCenterAndRadius();
    }

    public eraseParts(parts: CollisionParts): void {
        arrayRemoveIfExist(this.parts, parts);
    }

    public calcMinMaxAndRadiusIfMoveOuter(parts: CollisionParts): void {
        if (this.boundingSphereCenter === null || this.boundingSphereRadius === null || this.boundingAABB === null)
            return;

        parts.getTrans(scratchVec3a);
        const r = parts.boundingSphereRadius;
        if (!isInRange(scratchVec3a[0], this.boundingAABB.minX + r, this.boundingAABB.maxX - r) ||
            !isInRange(scratchVec3a[1], this.boundingAABB.minY + r, this.boundingAABB.maxY - r) ||
            !isInRange(scratchVec3a[2], this.boundingAABB.minZ + r, this.boundingAABB.maxZ - r))
            this.calcMinMaxAndRadius();
    }

    private calcCenterAndRadius(): void {
        this.boundingAABB!.centerPoint(this.boundingSphereCenter!);
        this.boundingSphereRadius = Math.sqrt(this.boundingAABB!.diagonalLengthSquared());
    }

    private calcMinMaxAddParts(parts: CollisionParts): boolean {
        if (this.boundingAABB === null)
            return false;

        let changed = false;

        vec3.set(scratchVec3b, parts.boundingSphereRadius, parts.boundingSphereRadius, parts.boundingSphereRadius);

        parts.getTrans(scratchVec3a);
        vec3.add(scratchVec3a, scratchVec3a, scratchVec3b);
        if (this.boundingAABB.unionPoint(scratchVec3a))
            changed = true;

        parts.getTrans(scratchVec3a);
        vec3.sub(scratchVec3a, scratchVec3a, scratchVec3b);
        if (this.boundingAABB.unionPoint(scratchVec3a))
            changed = true;

        return changed;
    }

    public calcMinMaxAndRadius(): void {
        if (this.boundingSphereCenter === null || this.boundingSphereRadius === null || this.boundingAABB === null)
            return;

        this.boundingAABB.reset();
        for (let i = 0; i < this.parts.length; i++)
            this.calcMinMaxAddParts(this.parts[i]);
        this.calcCenterAndRadius();
    }
}

function checkHitSegmentSphere(dstDirection: vec3 | null, p0: vec3, dir: vec3, sphereCenter: vec3, sphereRadius: number): boolean {
    // Put in space of P0
    vec3.sub(scratchVec3c, sphereCenter, p0);

    const dot = vec3.dot(scratchVec3c, dir);
    const sqSphereRadius = sphereRadius*sphereRadius;
    if (dot >= 0.0) {
        const sqSegLength = vec3.squaredLength(dir);
        if (sqSegLength >= dot) {
            // Arrow goes through sphere. Find the intersection point.
            vec3.scale(scratchVec3b, dir, dot / sqSegLength);
            if (vec3.squaredDistance(scratchVec3b, scratchVec3c) <= sqSphereRadius) {
                if (dstDirection !== null) {
                    vec3.negate(dstDirection, scratchVec3b);
                    vec3.normalize(dstDirection, dstDirection);
                }

                return true;
            }
        } else {
            // Arrow does not go through sphere; might or might not go inside. Check P1
            const sqDist = vec3.squaredDistance(dir, scratchVec3c);
            if (sqDist < sqSphereRadius) {
                if (dstDirection !== null) {
                    vec3.sub(dstDirection, scratchVec3c, dir);
                    vec3.normalize(dstDirection, dstDirection);
                }

                return true;
            }
        }
    } else {
        // Arrow is pointed away from the sphere. The only way that this could hit is if P0 is inside the sphere.
        const sqDist = vec3.squaredLength(scratchVec3c);
        if (sqDist < sqSphereRadius) {
            if (dstDirection !== null) {
                vec3.sub(dstDirection, sphereCenter, p0);
                vec3.normalize(dstDirection, dstDirection);
            }

            return true;
        }
    }

    return false;
}

const scratchAABB = new AABB();
class CollisionCategorizedKeeper {
    public strikeInfoCount: number = 0;
    public strikeInfo: HitInfo[] = nArray(32, () => new HitInfo());

    private zones: CollisionZone[] = [];
    private forceCalcMinMaxAndRadius = false;

    constructor(public keeperIdx: number) {
    }

    public movement(sceneObjHolder: SceneObjHolder): void {
        for (let i = 0; i < this.zones.length; i++) {
            const zone = this.zones[i];
            if (zone === undefined)
                continue;

            for (let j = 0; j < zone.parts.length; j++) {
                const parts = zone.parts[j];
                if (!parts.validated)
                    continue;

                if (this.keeperIdx === parts.keeperIdx)
                    parts.updateMtx();

                if (!this.forceCalcMinMaxAndRadius && parts.notMovedCounter === 0)
                    zone.calcMinMaxAndRadiusIfMoveOuter(parts);
            }

            if (this.forceCalcMinMaxAndRadius)
                zone.calcMinMaxAndRadius();
        }

        this.forceCalcMinMaxAndRadius = false;
    }

    public addToZone(parts: CollisionParts, zoneId: number): void {
        this.getZone(zoneId).addParts(parts);
    }

    public removeFromZone(parts: CollisionParts, zoneId: number): void {
        const zone = this.zones[zoneId];
        if (zone === undefined)
            return;
        zone.eraseParts(parts);
    }

    public addToGlobal(parts: CollisionParts): void {
        this.addToZone(parts, 0);
    }

    public removeFromGlobal(parts: CollisionParts): void {
        this.removeFromZone(parts, 0);
    }

    public getStrikeInfo(idx: number): HitInfo {
        return this.strikeInfo[idx];
    }

    public checkStrikeLine(p0: vec3, dir: vec3, partsFilter: CollisionPartsFilterBase | null, triFilter: TriangleFilterBase | null, maxStrikeInfos: number = this.strikeInfo.length): number {
        let idx = 0;

        scratchAABB.reset();
        scratchAABB.unionPoint(p0);
        vec3.add(scratchVec3a, p0, dir);
        scratchAABB.unionPoint(scratchVec3a);

        outer:
        for (let i = 0; i < this.zones.length; i++) {
            const zone = this.zones[i];
            if (zone === undefined)
                continue;

            if (zone.boundingSphereCenter !== null) {
                if (!scratchAABB.containsSphere(zone.boundingSphereCenter, zone.boundingSphereRadius!))
                    continue;

                if (!checkHitSegmentSphere(null, p0, dir, zone.boundingSphereCenter, zone.boundingSphereRadius!))
                    continue;
            }

            for (let j = 0; j < zone.parts.length; j++) {
                const parts = zone.parts[j];
                if (!parts.validated)
                    continue;
                if (partsFilter !== null && partsFilter.isInvalidParts(parts))
                    continue;

                parts.getTrans(scratchVec3a);
                if (!scratchAABB.containsSphere(scratchVec3a, parts.boundingSphereRadius))
                    continue;

                if (!checkHitSegmentSphere(null, p0, dir, scratchVec3a, parts.boundingSphereRadius))
                    continue;

                idx += parts.checkStrikeLine(this.strikeInfo, idx, p0, dir, triFilter);
                if (idx >= this.strikeInfo.length)
                    break outer;
            }
        }

        this.strikeInfoCount = idx;
        return idx;
    }

    public getZone(zoneId: number): CollisionZone {
        if (this.zones[zoneId] === undefined)
            this.zones[zoneId] = new CollisionZone(zoneId);

        return this.zones[zoneId];
    }
}

export class CollisionDirector extends NameObj {
    public keepers: CollisionCategorizedKeeper[] = [];

    constructor(sceneObjHolder: SceneObjHolder) {
        super(sceneObjHolder, 'CollisionDirector');

        for (let i = 0; i < 4; i++)
            this.keepers[i] = new CollisionCategorizedKeeper(i);

        connectToScene(sceneObjHolder, this, 0x20, -1, -1, -1);
    }

    public movement(sceneObjHolder: SceneObjHolder, viewerInput: ViewerRenderInput): void {
        super.movement(sceneObjHolder, viewerInput);

        for (let i = 0; i < this.keepers.length; i++)
            this.keepers[i].movement(sceneObjHolder);
    }
}

function isFloorPolygonAngle(v: number): boolean {
    // 70 degrees -- Math.cos(70*Math.PI/180)
    return Math.abs(v) < 0.3420201433256688;
}

function isFloorPolygon(normal: vec3, gravityVector: vec3): boolean {
    return isNearZeroVec3(normal, 0.001) && isFloorPolygonAngle(vec3.dot(normal, gravityVector));
}

const scratchVec3c = vec3.create();
const hitInfoScratch = nArray(0x20, () => new HitInfo());
export class Binder {
    public triangleFilter: TriangleFilterBase | null = null;
    private exCollisionParts: CollisionParts | null = null;
    private exCollisionPartsValid: boolean = false;
    private hitInfos: HitInfo[];
    private hitInfoCount: number;
    private floorHitDist: number;
    private wallHitDist: number;
    private roofHitDist: number;
    private useHostBaseMtx: boolean = false;

    public hostOffsetVec: vec3 | null = null;

    constructor(private hostBaseMtx: mat4 | null, private hostTranslation: vec3, private hostGravity: vec3, private hostCenterY: number, private radius: number, private hitInfoCapacity: number) {
        this.hitInfos = nArray(hitInfoCapacity, () => new HitInfo());
        this.clear();
    }

    public bind(dst: vec3, sceneObjHolder: SceneObjHolder, velocity: vec3): void {
        if (this.exCollisionPartsValid)
            sceneObjHolder.collisionDirector!.keepers[Category.Map].addToGlobal(assertExists(this.exCollisionParts));

        if (this.hostOffsetVec)
            vec3.copy(scratchVec3c, this.hostOffsetVec);
        else
            vec3.set(scratchVec3c, 0.0, this.hostCenterY, 0.0);

        if (this.useHostBaseMtx)
            transformVec3Mat4w0(scratchVec3c, this.hostBaseMtx!, scratchVec3c);

        vec3.add(scratchVec3c, this.hostTranslation, scratchVec3c);

        // this.findBindedPos(scratchVec3c, velocity, )

        if (this.exCollisionPartsValid)
            sceneObjHolder.collisionDirector!.keepers[Category.Map].removeFromGlobal(assertExists(this.exCollisionParts));
    }

    public findBindedPos(pos: vec3, vel: vec3): void {
    }

    public clear(): void {
        this.hitInfoCount = 0;
        this.floorHitDist = -99999.0;
        this.wallHitDist = -99999.0;
        this.roofHitDist = -99999.0;
    }

    public setTriangleFilter(filter: TriangleFilterBase): void {
        this.triangleFilter = filter;
    }

    public setExCollisionParts(parts: CollisionParts | null): void {
        this.exCollisionParts = parts;
        this.exCollisionPartsValid = this.exCollisionParts !== null;
    }
}

export function getFirstPolyOnLineCategory(sceneObjHolder: SceneObjHolder, dst: vec3 | null, dstTriangle: Triangle | null, p0: vec3, dir: vec3, triFilter: TriangleFilterBase | null, partsFilter: CollisionPartsFilterBase | null, category: Category): boolean {
    const director = sceneObjHolder.collisionDirector;
    if (director === null)
        return false;

    const keeper = director.keepers[category];
    const count = keeper.checkStrikeLine(p0, dir, partsFilter, null);
    if (count === 0)
        return false;

    let bestDist = Infinity, bestIdx = -1;
    for (let i = 0; i < count; i++) {
        const strikeInfo = keeper.getStrikeInfo(i);
        if (triFilter !== null && triFilter.isInvalidTriangle(strikeInfo))
            continue;
        if (strikeInfo.distance < bestDist) {
            bestDist = strikeInfo.distance;
            bestIdx = i;
        }
    }

    assert(bestIdx >= 0);
    const bestStrike = keeper.getStrikeInfo(bestIdx);

    if (dst !== null)
        vec3.copy(dst, bestStrike.strikeLoc);
    if (dstTriangle !== null)
        dstTriangle.copy(bestStrike);

    return true;
}

export function getFirstPolyOnLineToMap(sceneObjHolder: SceneObjHolder, dst: vec3, dstTriangle: Triangle | null, p0: vec3, dir: vec3): boolean {
    return getFirstPolyOnLineCategory(sceneObjHolder, dst, dstTriangle, p0, dir, null, null, Category.Map);
}

class CollisionPartsFilterActor extends CollisionPartsFilterBase {
    public actor: LiveActor | null = null;

    public isInvalidParts(parts: CollisionParts): boolean {
        return parts.hitSensor.actor === this.actor;
    }
}

export function getFirstPolyOnLineToMapExceptActor(sceneObjHolder: SceneObjHolder, dst: vec3, dstTriangle: Triangle | null, p0: vec3, dir: vec3, actor: LiveActor): boolean {
    const partsFilter = new CollisionPartsFilterActor();
    partsFilter.actor = actor;
    return getFirstPolyOnLineCategory(sceneObjHolder, dst, dstTriangle, p0, dir, null, partsFilter, Category.Map);
}

export function calcMapGround(sceneObjHolder: SceneObjHolder, dst: vec3, p0: vec3, height: number): boolean {
    vec3.set(scratchVec3c, 0.0, -height, 0.0);
    return getFirstPolyOnLineCategory(sceneObjHolder, dst, null, p0, scratchVec3c, null, null, Category.Map);
}

export const enum CollisionScaleType {
    AutoEqualScale,
    NotUsingScale,
    AutoScale,
}

function createCollisionParts(sceneObjHolder: SceneObjHolder, zoneAndLayer: ZoneAndLayer, resourceHolder: ResourceHolder, name: string, hitSensor: HitSensor, initialHostMtx: mat4, scaleType: CollisionScaleType, category: Category): CollisionParts {
    const kclData = assertExists(resourceHolder.arc.findFileData(`${name}.kcl`));
    const paData = resourceHolder.arc.findFileData(`${name}.pa`);
    return new CollisionParts(sceneObjHolder, zoneAndLayer, initialHostMtx, hitSensor, kclData, paData, category, scaleType);
}

export function validateCollisionParts(sceneObjHolder: SceneObjHolder, parts: CollisionParts): void {
    parts.addToBelongZone(sceneObjHolder);
    parts.validated = true;
}

export function invalidateCollisionParts(sceneObjHolder: SceneObjHolder, parts: CollisionParts): void {
    parts.removeFromBelongZone(sceneObjHolder);
    parts.validated = false;
}

const scratchMatrix = mat4.create();
export function createCollisionPartsFromLiveActor(sceneObjHolder: SceneObjHolder, actor: LiveActor, name: string, hitSensor: HitSensor, hostMtx: mat4 | null, scaleType: CollisionScaleType): CollisionParts {
    let initialHostMtx: mat4;
    if (hostMtx !== null) {
        initialHostMtx = hostMtx;
    } else {
        makeMtxTRSFromActor(scratchMatrix, actor);
        initialHostMtx = scratchMatrix;
    }

    const parts = createCollisionParts(sceneObjHolder, actor.zoneAndLayer, actor.resourceHolder, name, hitSensor, scratchMatrix, scaleType, Category.Map);

    if (hostMtx !== null)
        parts.hostMtx = hostMtx;

    return parts;
}

function tryCreateCollisionParts(sceneObjHolder: SceneObjHolder, actor: LiveActor, hitSensor: HitSensor, category: Category, filenameBase: string): CollisionParts | null {
    const res = actor.resourceHolder.arc.findFileData(`${filenameBase}.kcl`);
    if (res === null)
        return null;

    makeMtxTRSFromActor(scratchMatrix, actor);
    const parts = createCollisionParts(sceneObjHolder, actor.zoneAndLayer, actor.resourceHolder, filenameBase, hitSensor, scratchMatrix, CollisionScaleType.AutoScale, category);
    if (parts !== null)
        validateCollisionParts(sceneObjHolder, parts);

    return parts;
}

export function tryCreateCollisionMoveLimit(sceneObjHolder: SceneObjHolder, actor: LiveActor, hitSensor: HitSensor): CollisionParts | null {
    return tryCreateCollisionParts(sceneObjHolder, actor, hitSensor, Category.MoveLimit, 'MoveLimit');
}

export function tryCreateCollisionWaterSurface(sceneObjHolder: SceneObjHolder, actor: LiveActor, hitSensor: HitSensor): CollisionParts | null {
    return tryCreateCollisionParts(sceneObjHolder, actor, hitSensor, Category.WaterSurface, 'WaterSurface');
}
