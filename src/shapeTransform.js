import { callAny, makeInstance, tryCallAnyArgs } from './occtRuntime.js';

function normalizedRotation(rotation = {}) {
  return {
    x: Number.isFinite(Number(rotation.x)) ? Number(rotation.x) : 0,
    y: Number.isFinite(Number(rotation.y)) ? Number(rotation.y) : 0,
    z: Number.isFinite(Number(rotation.z)) ? Number(rotation.z) : 0
  };
}

function makeRotationTransform(oc, axis, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const transform = makeInstance(oc, 'gp_Trsf');
  const direction = axis === 'x'
    ? [1, 0, 0]
    : axis === 'y'
      ? [0, 1, 0]
      : [0, 0, 1];
  const axisLine = makeInstance(oc, 'gp_Ax1', [
    makeInstance(oc, 'gp_Pnt', [0, 0, 0]),
    makeInstance(oc, 'gp_Dir', direction)
  ]);

  callAny(transform, ['SetRotation'], [axisLine, radians]);
  return transform;
}

function transformShape(oc, shape, transform) {
  const attempts = [
    () => makeInstance(oc, 'BRepBuilderAPI_Transform', [shape, transform, true]),
    () => {
      const builder = makeInstance(oc, 'BRepBuilderAPI_Transform', [transform]);
      tryCallAnyArgs(builder, ['Perform'], [[shape, true], [shape]]);
      return builder;
    }
  ];

  for (const attempt of attempts) {
    try {
      const builder = attempt();
      const done = tryCallAnyArgs(builder, ['IsDone'], [[]]);

      if (done.called && !done.value) {
        continue;
      }

      const result = callAny(builder, ['Shape']);
      return callAny(result, ['IsNull']) ? shape : result;
    } catch {
      // Try the next OpenCascade.js overload.
    }
  }

  return shape;
}

export function rotateShape(oc, shape, rotation) {
  const normalized = normalizedRotation(rotation);
  let result = shape;

  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(normalized[axis]) <= 1e-9) {
      continue;
    }

    result = transformShape(oc, result, makeRotationTransform(oc, axis, normalized[axis]));
  }

  return result;
}
