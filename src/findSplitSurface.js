const Z_AXIS = [0, 0, 1];
const EPSILON = 1e-10;

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function length(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalize(vector) {
  const magnitude = length(vector);

  if (magnitude <= EPSILON) {
    return null;
  }

  return vector.map((value) => value / magnitude);
}

function scale(vector, factor) {
  return vector.map((value) => value * factor);
}

function add(left, right) {
  return [
    left[0] + right[0],
    left[1] + right[1],
    left[2] + right[2]
  ];
}

function subtract(left, right) {
  return [
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2]
  ];
}

function planeFromNormalAndPoint(normal, point) {
  const unit = normalize(normal);

  return {
    type: 'plane',
    normal: unit,
    point: [...point]
  };
}

function zProjectionOntoRadialPlane(axis) {
  const unitAxis = normalize(axis);

  if (!unitAxis) {
    return null;
  }

  return subtract(Z_AXIS, scale(unitAxis, dot(Z_AXIS, unitAxis)));
}

function orthonormalFrame(axis, xDirection) {
  const z = normalize(axis);

  if (!z) {
    return null;
  }

  const rawX = xDirection
    ? subtract(xDirection, scale(z, dot(xDirection, z)))
    : zProjectionOntoRadialPlane(z);
  const x = normalize(rawX);

  if (!x) {
    return null;
  }

  const y = normalize(cross(z, x));

  if (!y) {
    return null;
  }

  return { x, y, z };
}

export function findCylinderSplitSurfaces(cylinder, draftAngleDegrees) {
  const threshold = Math.sin((draftAngleDegrees * Math.PI) / 180);
  const normalDirection = cylinder.normalDirection ?? 1;
  const axis = normalize(cylinder.axis);
  const radialZ = axis ? zProjectionOntoRadialPlane(axis) : null;
  const radialZLengthSquared = radialZ ? dot(radialZ, radialZ) : 0;
  const targetNormalZ = threshold / normalDirection;

  if (radialZLengthSquared <= EPSILON || Math.abs(targetNormalZ) > Math.sqrt(radialZLengthSquared) + 1e-10) {
    return [];
  }

  const offsetPoint = add(
    cylinder.location,
    scale(radialZ, (cylinder.radius * targetNormalZ) / radialZLengthSquared)
  );
  const plane = planeFromNormalAndPoint(radialZ, offsetPoint);

  return plane ? [plane] : [];
}

export function findConeSplitSurfaces(cone, draftAngleDegrees) {
  const semiAngle = cone.semiAngle ?? 0;
  const threshold = Math.sin((draftAngleDegrees * Math.PI) / 180);
  const normalDirection = cone.normalDirection ?? 1;
  const axis = normalize(cone.axis);
  const radialZ = axis ? zProjectionOntoRadialPlane(axis) : null;
  const radialZLength = radialZ ? length(radialZ) : 0;
  const normalScale = Math.cos(semiAngle);

  if (!axis || radialZLength <= EPSILON || Math.abs(normalScale) <= EPSILON) {
    return [];
  }

  const axisZ = dot(axis, Z_AXIS);
  const targetRadialZ = ((threshold / normalDirection) + Math.sin(semiAngle) * axisZ) / normalScale;

  if (Math.abs(targetRadialZ) > radialZLength + 1e-10) {
    return [];
  }

  const planeNormal = subtract(radialZ, scale(axis, Math.tan(semiAngle) * targetRadialZ));
  const plane = planeFromNormalAndPoint(planeNormal, cone.apex);

  return plane ? [plane] : [];
}

export function findSphereSplitSurfaces(sphere, draftAngleDegrees) {
  const threshold = Math.sin((draftAngleDegrees * Math.PI) / 180);
  const normalDirection = sphere.normalDirection ?? 1;

  if (Math.abs(threshold) >= 1) {
    return [];
  }

  return [
    planeFromNormalAndPoint(Z_AXIS, [
      sphere.center[0],
      sphere.center[1],
      sphere.center[2] + sphere.radius * threshold / normalDirection
    ])
  ].filter(Boolean);
}

export function findTorusSplitSurfaces(torus, draftAngleDegrees) {
  const threshold = Math.sin((draftAngleDegrees * Math.PI) / 180);
  const normalDirection = torus.normalDirection ?? 1;
  const frame = orthonormalFrame(torus.axis, torus.xDirection);

  console.log('Torus split frame:', frame);

  if (!frame || Math.abs(threshold) >= 1) {
    return [];
  }

  const targetNormalZ = threshold / normalDirection;
  const axisZ = dot(frame.z, Z_AXIS);

  if (Math.abs(Math.abs(axisZ) - 1) <= 1e-7) {
    return [
      planeFromNormalAndPoint(Z_AXIS, [
        torus.center[0],
        torus.center[1],
        torus.center[2] + torus.minorRadius * targetNormalZ
      ])
    ].filter(Boolean);
  }

  const uCount = 73;
  const vCount = 13;
  const points = [];
  const minorPadding = torus.minorRadius * 2.25;
  const zPadding = torus.minorRadius * 2.5;

  for (let uIndex = 0; uIndex < uCount; uIndex += 1) {
    const u = (Math.PI * 2 * uIndex) / (uCount - 1);
    const radial = add(scale(frame.x, Math.cos(u)), scale(frame.y, Math.sin(u)));
    const radialZ = dot(radial, Z_AXIS);
    const row = [];

    for (let vIndex = 0; vIndex < vCount; vIndex += 1) {
      const t = -1 + (2 * vIndex) / (vCount - 1);

      if (Math.abs(axisZ) > 1e-7) {
        const rho = torus.majorRadius + minorPadding * t;
        const axisOffset = (torus.minorRadius * targetNormalZ - (rho - torus.majorRadius) * radialZ) / axisZ;
        row.push(add(torus.center, add(scale(radial, rho), scale(frame.z, axisOffset))));
      } else if (Math.abs(radialZ) > 1e-7) {
        const rho = torus.majorRadius + (torus.minorRadius * targetNormalZ) / radialZ;
        const axisOffset = zPadding * t;
        row.push(add(torus.center, add(scale(radial, rho), scale(frame.z, axisOffset))));
      } else {
        const fallbackRho = torus.majorRadius + minorPadding * t;
        row.push(add(torus.center, scale(radial, fallbackRho)));
      }
    }

    points.push(row);
  }

  return [{
    points,
    type: 'pointGridSurface'
  }];
}
