import { callAny, enumValue, makeInstance } from './occtRuntime.js';

export function faceFromExplorer(oc, explorer) {
  const shape = callAny(explorer, ['Current']);

  if (oc.TopoDS?.Face_1) {
    return oc.TopoDS.Face_1(shape);
  }

  if (oc.TopoDS?.Face) {
    return oc.TopoDS.Face(shape);
  }

  return shape;
}

export function makeExplorer(oc, shape, kind) {
  try {
    return makeInstance(oc, 'TopExp_Explorer', [shape, kind]);
  } catch {
    const explorer = makeInstance(oc, 'TopExp_Explorer');
    explorer.Init(shape, kind, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_SHAPE'));
    return explorer;
  }
}

export function edgeFromExplorer(oc, explorer) {
  const shape = callAny(explorer, ['Current']);

  if (oc.TopoDS?.Edge_1) {
    return oc.TopoDS.Edge_1(shape);
  }

  if (oc.TopoDS?.Edge) {
    return oc.TopoDS.Edge(shape);
  }

  return shape;
}

export function getCoord(point, name) {
  return callAny(point, [name]);
}

export function shapeOrientation(shape) {
  return callAny(shape, ['Orientation', 'Orientation_1']);
}

export function shapeKey(shape, fallback) {
  return typeof shape?.HashCode === 'function' ? shape.HashCode(1000000007) : fallback;
}

export function pointToArray(point) {
  return [getCoord(point, 'X'), getCoord(point, 'Y'), getCoord(point, 'Z')];
}

export function directionToArray(direction) {
  return [getCoord(direction, 'X'), getCoord(direction, 'Y'), getCoord(direction, 'Z')];
}

export function axisToData(axis) {
  return {
    location: pointToArray(callAny(axis, ['Location'])),
    direction: directionToArray(callAny(axis, ['Direction']))
  };
}

export function distanceBetween(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
