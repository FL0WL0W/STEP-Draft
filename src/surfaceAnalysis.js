import {
  findConeSplitSurfaces,
  findCylinderSplitSurfaces,
  findGeneralSurfaceSplitSurfaces,
  findSphereSplitSurfaces,
  findTorusSplitSurfaces
} from './findSplitSurface.js';
import { callAny, enumValue, makeInstance } from './occtRuntime.js';
import {
  axisToData,
  directionToArray,
  distanceBetween,
  edgeFromExplorer,
  makeExplorer,
  pointToArray,
  shapeOrientation
} from './shapeTraversal.js';

function normalizeVector(nx, ny, nz) {
  const length = Math.hypot(nx, ny, nz);

  if (length === 0) {
    return { nx: 0, ny: 0, nz: 1 };
  }

  return { nx: nx / length, ny: ny / length, nz: nz / length };
}

export function getSurfaceType(oc, surface) {
  const type = callAny(surface, ['GetType']);

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_Plane')) {
    return 'plane';
  }

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_Cylinder')) {
    return 'cylinder';
  }

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_Cone')) {
    return 'cone';
  }

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_Sphere')) {
    return 'sphere';
  }

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_Torus')) {
    return 'torus';
  }

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_BSplineSurface')) {
    return 'bspline';
  }

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_BezierSurface')) {
    return 'bezier';
  }

  return 'generic';
}

export function isGeneralSurfaceType(surfaceType) {
  return surfaceType === 'bspline' || surfaceType === 'bezier';
}

export function faceBoundaryTouchesPoint(oc, face, target, tolerance) {
  const explorer = makeExplorer(oc, face, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_EDGE'));

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    const edge = edgeFromExplorer(oc, explorer);
    let curve;

    try {
      curve = makeInstance(oc, 'BRepAdaptor_Curve', [edge]);
    } catch {
      continue;
    }

    const first = callAny(curve, ['FirstParameter']);
    const last = callAny(curve, ['LastParameter']);

    if (!Number.isFinite(first) || !Number.isFinite(last)) {
      continue;
    }

    for (const parameter of [first, (first + last) * 0.5, last]) {
      if (distanceBetween(pointToArray(callAny(curve, ['Value'], [parameter])), target) <= tolerance) {
        return true;
      }
    }
  }

  return false;
}

export function primitiveSplitSurfacesForFace(oc, face, draftAngleDegrees) {
  const surface = makeInstance(oc, 'BRepAdaptor_Surface', [face, true]);
  const surfaceType = getSurfaceType(oc, surface);
  const normalDirection = shapeOrientation(face) === enumValue(oc, 'TopAbs_Orientation', 'TopAbs_REVERSED') ? -1 : 1;

  if (surfaceType === 'cylinder') {
    const cylinder = callAny(surface, ['Cylinder']);
    const axis = axisToData(callAny(cylinder, ['Axis']));
    return findCylinderSplitSurfaces({
      axis: axis.direction,
      location: pointToArray(callAny(cylinder, ['Location'])),
      radius: callAny(cylinder, ['Radius']),
      normalDirection
    }, draftAngleDegrees);
  }

  if (surfaceType === 'cone') {
    const cone = callAny(surface, ['Cone']);
    const axis = axisToData(callAny(cone, ['Axis']));
    const apex = pointToArray(callAny(cone, ['Apex']));

    return findConeSplitSurfaces({
      apex,
      axis: axis.direction,
      semiAngle: callAny(cone, ['SemiAngle']),
      normalDirection
    }, draftAngleDegrees);
  }

  if (surfaceType === 'sphere') {
    const sphere = callAny(surface, ['Sphere']);
    return findSphereSplitSurfaces({
      center: pointToArray(callAny(sphere, ['Location'])),
      radius: callAny(sphere, ['Radius']),
      normalDirection
    }, draftAngleDegrees);
  }

  if (surfaceType === 'torus') {
    const torus = callAny(surface, ['Torus']);
    const axis = axisToData(callAny(torus, ['Axis']));
    const position = callAny(torus, ['Position']);
    const majorRadius = callAny(torus, ['MajorRadius']);
    const minorRadius = callAny(torus, ['MinorRadius']);
    return findTorusSplitSurfaces({
      axis: axis.direction,
      center: pointToArray(callAny(torus, ['Location'])),
      xDirection: directionToArray(callAny(position, ['XDirection'])),
      majorRadius,
      minorRadius,
      normalDirection
    }, draftAngleDegrees);
  }

  if (surfaceType === 'bspline' || surfaceType === 'bezier') {
    const forward = shapeOrientation(face) !== enumValue(oc, 'TopAbs_Orientation', 'TopAbs_REVERSED');

    return findGeneralSurfaceSplitSurfaces({
      evaluate(u, v) {
        const point = pointToArray(callAny(surface, ['Value'], [u, v]));
        const normal = normalFromDerivatives(oc, surface, u, v, forward);

        return {
          normal: [normal.nx, normal.ny, normal.nz],
          point
        };
      },
      uMax: callAny(surface, ['LastUParameter']),
      uMin: callAny(surface, ['FirstUParameter']),
      vMax: callAny(surface, ['LastVParameter']),
      vMin: callAny(surface, ['FirstVParameter'])
    }, draftAngleDegrees);
  }

  return [];
}

export function normalFromDerivatives(oc, surface, u, v, forward) {
  const point = makeInstance(oc, 'gp_Pnt');
  const du = makeInstance(oc, 'gp_Vec');
  const dv = makeInstance(oc, 'gp_Vec');

  callAny(surface, ['D1'], [u, v, point, du, dv]);

  let nx = callAny(du, ['Y']) * callAny(dv, ['Z']) - callAny(du, ['Z']) * callAny(dv, ['Y']);
  let ny = callAny(du, ['Z']) * callAny(dv, ['X']) - callAny(du, ['X']) * callAny(dv, ['Z']);
  let nz = callAny(du, ['X']) * callAny(dv, ['Y']) - callAny(du, ['Y']) * callAny(dv, ['X']);

  ({ nx, ny, nz } = normalizeVector(nx, ny, nz));

  if (!forward) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }

  return { nx, ny, nz };
}
