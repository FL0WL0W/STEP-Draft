const Z_AXIS = [0, 0, 1];
const EPSILON = 1e-10;
const GENERAL_SURFACE_HYSTERESIS_DEGREES = 0.25;
const GENERAL_SURFACE_MAX_DEBUG_CONTOURS = 1;
const GENERAL_SURFACE_MIN_VALIDATION_SCORE = 0.55;

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

function distance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
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

  if (!frame || Math.abs(threshold) >= 1) {
    return [];
  }

  const targetNormalZ = threshold / normalDirection;
  const axisZ = dot(frame.z, Z_AXIS);
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

function draftAngleFromNormalZ(nz) {
  return (Math.asin(Math.min(Math.max(nz, -1), 1)) * 180) / Math.PI;
}

function connectUvSegments(segments, tolerance) {
  const nodes = [];
  const edgeVisited = new Set();
  const uvDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function nodeFor(uv) {
    for (let index = 0; index < nodes.length; index += 1) {
      if (uvDistance(nodes[index].uv, uv) <= tolerance) {
        const node = nodes[index];
        node.count += 1;
        node.uv = [
          node.uv[0] + (uv[0] - node.uv[0]) / node.count,
          node.uv[1] + (uv[1] - node.uv[1]) / node.count
        ];
        return index;
      }
    }

    nodes.push({ count: 1, links: [], uv: [uv[0], uv[1]] });
    return nodes.length - 1;
  }

  segments.forEach((segment, segmentIndex) => {
    const start = nodeFor(segment[0]);
    const end = nodeFor(segment[1]);

    if (start === end) {
      return;
    }

    nodes[start].links.push({ edgeId: segmentIndex, to: end });
    nodes[end].links.push({ edgeId: segmentIndex, to: start });
  });

  function nextUnvisitedLink(nodeIndex, previousNodeIndex = null) {
    const links = nodes[nodeIndex]?.links || [];
    return links.find((link) => link.to !== previousNodeIndex && !edgeVisited.has(link.edgeId)) ||
      links.find((link) => !edgeVisited.has(link.edgeId)) ||
      null;
  }

  function walkFrom(startNodeIndex, firstLink) {
    const contour = [nodes[startNodeIndex].uv];
    let previousNodeIndex = startNodeIndex;
    let currentLink = firstLink;

    while (currentLink && !edgeVisited.has(currentLink.edgeId)) {
      edgeVisited.add(currentLink.edgeId);
      const currentNodeIndex = currentLink.to;
      contour.push(nodes[currentNodeIndex].uv);
      currentLink = nextUnvisitedLink(currentNodeIndex, previousNodeIndex);
      previousNodeIndex = currentNodeIndex;

      if (currentNodeIndex === startNodeIndex) {
        break;
      }
    }

    return contour;
  }

  const contours = [];
  const startNodeIndices = [
    ...nodes.map((node, index) => ({ degree: node.links.length, index })).filter((entry) => entry.degree === 1).map((entry) => entry.index),
    ...nodes.map((node, index) => ({ degree: node.links.length, index })).filter((entry) => entry.degree !== 1).map((entry) => entry.index)
  ];

  for (const startNodeIndex of startNodeIndices) {
    let link = nextUnvisitedLink(startNodeIndex);

    while (link) {
      contours.push(walkFrom(startNodeIndex, link));
      link = nextUnvisitedLink(startNodeIndex);
    }
  }

  return contours;
}

function densifyUvContour(contour, targetCount = 8) {
  if (contour.length >= targetCount) {
    return contour;
  }

  const dense = [];

  for (let index = 0; index < contour.length - 1; index += 1) {
    const start = contour[index];
    const end = contour[index + 1];
    const steps = Math.max(1, Math.ceil(targetCount / Math.max(1, contour.length - 1)));

    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      dense.push([
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t
      ]);
    }
  }

  dense.push(contour[contour.length - 1]);
  return dense;
}

function uvContourLength(contour) {
  let total = 0;

  for (let index = 0; index < contour.length - 1; index += 1) {
    total += Math.hypot(contour[index + 1][0] - contour[index][0], contour[index + 1][1] - contour[index][1]);
  }

  return total;
}

function uvOrientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function uvSegmentsIntersect(a, b, c, d, tolerance = 1e-10) {
  const abC = uvOrientation(a, b, c);
  const abD = uvOrientation(a, b, d);
  const cdA = uvOrientation(c, d, a);
  const cdB = uvOrientation(c, d, b);

  return (
    Math.max(a[0], b[0]) + tolerance >= Math.min(c[0], d[0]) &&
    Math.max(c[0], d[0]) + tolerance >= Math.min(a[0], b[0]) &&
    Math.max(a[1], b[1]) + tolerance >= Math.min(c[1], d[1]) &&
    Math.max(c[1], d[1]) + tolerance >= Math.min(a[1], b[1]) &&
    abC * abD < -tolerance &&
    cdA * cdB < -tolerance
  );
}

function uvContourSelfIntersects(contour) {
  for (let left = 0; left < contour.length - 1; left += 1) {
    for (let right = left + 2; right < contour.length - 1; right += 1) {
      if (left === 0 && right === contour.length - 2) {
        continue;
      }

      if (uvSegmentsIntersect(contour[left], contour[left + 1], contour[right], contour[right + 1])) {
        return true;
      }
    }
  }

  return false;
}

function uvContourMaxTurnRadians(contour) {
  let maxTurn = 0;

  for (let index = 1; index < contour.length - 1; index += 1) {
    const ax = contour[index][0] - contour[index - 1][0];
    const ay = contour[index][1] - contour[index - 1][1];
    const bx = contour[index + 1][0] - contour[index][0];
    const by = contour[index + 1][1] - contour[index][1];
    const aLength = Math.hypot(ax, ay);
    const bLength = Math.hypot(bx, by);

    if (aLength <= 1e-12 || bLength <= 1e-12) {
      continue;
    }

    maxTurn = Math.max(maxTurn, Math.acos(Math.min(Math.max((ax * bx + ay * by) / (aLength * bLength), -1), 1)));
  }

  return maxTurn;
}

export function findGeneralSurfaceSplitSurfaces(surface, draftAngleDegrees) {
  const { evaluate, uMax, uMin, vMax, vMin } = surface;

  if (![uMin, uMax, vMin, vMax].every(Number.isFinite) || uMax <= uMin || vMax <= vMin) {
    return [];
  }

  const uCount = 17;
  const vCount = 17;
  const values = [];
  const samples = [];

  for (let uIndex = 0; uIndex < uCount; uIndex += 1) {
    const u = uMin + ((uMax - uMin) * uIndex) / (uCount - 1);
    const valueRow = [];
    const sampleRow = [];

    for (let vIndex = 0; vIndex < vCount; vIndex += 1) {
      const v = vMin + ((vMax - vMin) * vIndex) / (vCount - 1);

      try {
        const sample = evaluate(u, v);
        valueRow.push(draftAngleFromNormalZ(sample.normal[2]) - draftAngleDegrees);
        sampleRow.push(sample);
      } catch {
        valueRow.push(Number.NaN);
        sampleRow.push(null);
      }
    }

    values.push(valueRow);
    samples.push(sampleRow);
  }

  const segments = [];
  const uStep = (uMax - uMin) / (uCount - 1);
  const vStep = (vMax - vMin) / (vCount - 1);

  function interpolateUv(a, b, valueA, valueB) {
    const denominator = valueA - valueB;
    const t = Math.abs(denominator) <= 1e-12 ? 0.5 : valueA / denominator;

    return [
      a[0] + (b[0] - a[0]) * Math.min(Math.max(t, 0), 1),
      a[1] + (b[1] - a[1]) * Math.min(Math.max(t, 0), 1)
    ];
  }

  function pushMarchingSegments(target, corners) {
    const crossings = [];

    for (const [leftIndex, rightIndex] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
      const left = corners[leftIndex];
      const right = corners[rightIndex];

      if (left.value === 0) {
        crossings.push(left.uv);
      }

      if (left.value * right.value < 0) {
        crossings.push(interpolateUv(left.uv, right.uv, left.value, right.value));
      }
    }

    if (crossings.length === 2) {
      target.push([crossings[0], crossings[1]]);
    } else if (crossings.length === 4) {
      target.push([crossings[0], crossings[1]], [crossings[2], crossings[3]]);
    }
  }

  for (let uIndex = 0; uIndex < uCount - 1; uIndex += 1) {
    for (let vIndex = 0; vIndex < vCount - 1; vIndex += 1) {
      const corners = [
        { uv: [uMin + ((uMax - uMin) * uIndex) / (uCount - 1), vMin + ((vMax - vMin) * vIndex) / (vCount - 1)], value: values[uIndex][vIndex] },
        { uv: [uMin + ((uMax - uMin) * (uIndex + 1)) / (uCount - 1), vMin + ((vMax - vMin) * vIndex) / (vCount - 1)], value: values[uIndex + 1][vIndex] },
        { uv: [uMin + ((uMax - uMin) * (uIndex + 1)) / (uCount - 1), vMin + ((vMax - vMin) * (vIndex + 1)) / (vCount - 1)], value: values[uIndex + 1][vIndex + 1] },
        { uv: [uMin + ((uMax - uMin) * uIndex) / (uCount - 1), vMin + ((vMax - vMin) * (vIndex + 1)) / (vCount - 1)], value: values[uIndex][vIndex + 1] }
      ];

      if (corners.some((corner) => !Number.isFinite(corner.value))) {
        continue;
      }

      if (Math.min(...corners.map((corner) => corner.value)) <= 0 && Math.max(...corners.map((corner) => corner.value)) >= 0) {
        pushMarchingSegments(segments, corners);
      }

      if (segments.length > 180) {
        break;
      }
    }

    if (segments.length > 180) {
      break;
    }
  }

  if (segments.length === 0) {
    return [];
  }

  function draftErrorAt(u, v) {
    if (u < uMin || u > uMax || v < vMin || v > vMax) {
      return null;
    }

    try {
      return draftAngleFromNormalZ(evaluate(u, v).normal[2]) - draftAngleDegrees;
    } catch {
      return null;
    }
  }

  function contourGradient(uv) {
    const uMinus = Math.max(uMin, uv[0] - uStep * 0.35);
    const uPlus = Math.min(uMax, uv[0] + uStep * 0.35);
    const vMinus = Math.max(vMin, uv[1] - vStep * 0.35);
    const vPlus = Math.min(vMax, uv[1] + vStep * 0.35);
    const left = draftErrorAt(uMinus, uv[1]);
    const right = draftErrorAt(uPlus, uv[1]);
    const down = draftErrorAt(uv[0], vMinus);
    const up = draftErrorAt(uv[0], vPlus);

    if ([left, right, down, up].some((value) => value === null)) {
      return null;
    }

    const du = uPlus - uMinus;
    const dv = vPlus - vMinus;

    if (du <= 1e-12 || dv <= 1e-12) {
      return null;
    }

    const gu = (right - left) / du;
    const gv = (up - down) / dv;
    const gradientLength = Math.hypot(gu, gv);
    return gradientLength <= 1e-8 ? null : [gu / gradientLength, gv / gradientLength];
  }

  function scanContourSide(uv, direction) {
    const baseDistance = Math.hypot(uStep, vStep) * 0.2;
    let bestValue = null;

    for (const factor of [1, 2, 4, 8, 16, 32]) {
      const value = draftErrorAt(uv[0] + direction[0] * baseDistance * factor, uv[1] + direction[1] * baseDistance * factor);

      if (value === null) {
        continue;
      }

      if (bestValue === null || Math.abs(value) > Math.abs(bestValue)) {
        bestValue = value;
      }

      if (value >= GENERAL_SURFACE_HYSTERESIS_DEGREES) {
        return 'pass';
      }

      if (value <= -GENERAL_SURFACE_HYSTERESIS_DEGREES) {
        return 'fail';
      }
    }

    if (bestValue !== null && Math.abs(bestValue) >= GENERAL_SURFACE_HYSTERESIS_DEGREES * 0.4) {
      return bestValue > 0 ? 'pass' : 'fail';
    }

    return 'unknown';
  }

  function validateContour(contour) {
    const sampleCount = Math.min(24, contour.length);
    let validSamples = 0;
    let checkedSamples = 0;
    let unknownSamples = 0;

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const uv = contour[Math.round((sampleIndex * (contour.length - 1)) / Math.max(1, sampleCount - 1))];
      const gradient = contourGradient(uv);

      if (!gradient) {
        continue;
      }

      const positiveSide = scanContourSide(uv, gradient);
      const negativeSide = scanContourSide(uv, [-gradient[0], -gradient[1]]);

      if (positiveSide === 'unknown' || negativeSide === 'unknown') {
        unknownSamples += 1;
        continue;
      }

      checkedSamples += 1;

      if (positiveSide !== negativeSide) {
        validSamples += 1;
      }
    }

    return {
      checkedSamples,
      score: checkedSamples > 0 ? validSamples / checkedSamples : 0,
      unknownSamples,
      validSamples
    };
  }

  const finiteSamples = samples.flat().filter(Boolean);
  const minPoint = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maxPoint = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];

  for (const sample of finiteSamples) {
    for (let index = 0; index < 3; index += 1) {
      minPoint[index] = Math.min(minPoint[index], sample.point[index]);
      maxPoint[index] = Math.max(maxPoint[index], sample.point[index]);
    }
  }

  const diagonal = distance(minPoint, maxPoint);
  const normalOffset = Math.max(diagonal * 0.08, 1);
  const uvCellDiagonal = Math.hypot(uStep, vStep);
  const uvTolerance = Math.max(uvCellDiagonal * 1e-6, 1e-10);
  const rawContourCandidates = connectUvSegments(segments, uvTolerance)
    .map((contour) => densifyUvContour(contour))
    .filter((contour) => contour.length >= 4)
    .map((contour) => ({
      contour,
      isSelfIntersecting: uvContourSelfIntersects(contour),
      length: uvContourLength(contour),
      maxTurnRadians: uvContourMaxTurnRadians(contour),
      validation: validateContour(contour)
    }));
  const validatedContourCandidates = rawContourCandidates.filter((candidate) => (
    (candidate.validation.checkedSamples >= 2 && candidate.validation.score >= GENERAL_SURFACE_MIN_VALIDATION_SCORE) ||
    (candidate.length >= uvTolerance * 3 && candidate.validation.checkedSamples > 0 && candidate.validation.validSamples > 0)
  ));
  const contourCandidatePool = validatedContourCandidates.length > 0 ? validatedContourCandidates : rawContourCandidates;
  const cleanContourCandidates = contourCandidatePool.filter((candidate) => !candidate.isSelfIntersecting && candidate.maxTurnRadians < Math.PI * 0.96);
  const contourCandidates = (cleanContourCandidates.length > 0 ? cleanContourCandidates : contourCandidatePool)
    .sort((left, right) => (
      Number(left.isSelfIntersecting) - Number(right.isSelfIntersecting) ||
      right.validation.score - left.validation.score ||
      right.validation.validSamples - left.validation.validSamples ||
      right.length - left.length ||
      left.maxTurnRadians - right.maxTurnRadians ||
      right.validation.unknownSamples - left.validation.unknownSamples
    ))
    .slice(0, GENERAL_SURFACE_MAX_DEBUG_CONTOURS);

  function resampleContourBySurfaceDistance(contour, targetCount) {
    if (contour.length < 2 || targetCount <= 2) {
      return contour;
    }

    const pointSamples = contour.map((uv) => ({ point: evaluate(uv[0], uv[1]).point, uv }));
    const distances = [0];

    for (let index = 1; index < pointSamples.length; index += 1) {
      distances.push(distances[index - 1] + distance(pointSamples[index - 1].point, pointSamples[index].point));
    }

    const totalDistance = distances[distances.length - 1];

    if (!Number.isFinite(totalDistance) || totalDistance <= 1e-9) {
      return contour;
    }

    const resampled = [];
    let segmentIndex = 1;

    for (let sampleIndex = 0; sampleIndex < targetCount; sampleIndex += 1) {
      const targetDistance = (totalDistance * sampleIndex) / (targetCount - 1);

      while (segmentIndex < distances.length - 1 && distances[segmentIndex] < targetDistance) {
        segmentIndex += 1;
      }

      const leftDistance = distances[segmentIndex - 1];
      const rightDistance = distances[segmentIndex];
      const t = rightDistance - leftDistance <= 1e-12 ? 0 : (targetDistance - leftDistance) / (rightDistance - leftDistance);
      const left = pointSamples[segmentIndex - 1].uv;
      const right = pointSamples[segmentIndex].uv;

      resampled.push([
        left[0] + (right[0] - left[0]) * Math.min(Math.max(t, 0), 1),
        left[1] + (right[1] - left[1]) * Math.min(Math.max(t, 0), 1)
      ]);
    }

    return resampled;
  }

  function extendPointGridAlongContour(pointGrid) {
    if (pointGrid.length < 2) {
      return pointGrid;
    }

    const centerCol = Math.floor((pointGrid[0]?.length || 1) / 2);
    const centerPoints = pointGrid.map((row) => row[centerCol]).filter(Boolean);

    if (centerPoints.length < 2) {
      return pointGrid;
    }

    let totalLength = 0;

    for (let index = 1; index < centerPoints.length; index += 1) {
      totalLength += distance(centerPoints[index - 1], centerPoints[index]);
    }

    const averageLength = totalLength / Math.max(1, centerPoints.length - 1);
    const extensionLength = Math.min(Math.max(averageLength * 2, diagonal * 0.03, 0.1), Math.max(diagonal * 0.15, averageLength * 4, 0.1));
    const startDirection = normalize(subtract(centerPoints[0], centerPoints[1]));
    const endDirection = normalize(subtract(centerPoints[centerPoints.length - 1], centerPoints[centerPoints.length - 2]));

    if (!startDirection || !endDirection) {
      return pointGrid;
    }

    return [
      pointGrid[0].map((point) => add(point, scale(startDirection, extensionLength))),
      ...pointGrid,
      pointGrid[pointGrid.length - 1].map((point) => add(point, scale(endDirection, extensionLength)))
    ];
  }

  return contourCandidates.map(({ contour, isSelfIntersecting, length: contourLength, maxTurnRadians, validation }) => {
    const points = [];
    const contourSurfacePoints = [];
    const spacedContour = resampleContourBySurfaceDistance(contour, Math.min(Math.max(contour.length, 12), 64));

    for (const [u, v] of spacedContour) {
      const sample = evaluate(u, v);
      contourSurfacePoints.push(sample.point);
      points.push([-2, 0, 2].map((factor) => add(sample.point, scale(sample.normal, factor * normalOffset))));
    }

    const extendedPoints = extendPointGridAlongContour(points);

    return {
      contourLength,
      contourMaxTurnRadians: maxTurnRadians,
      contourPoints: contour.length,
      contourResampledPoints: spacedContour.length,
      contourSelfIntersects: isSelfIntersecting,
      contourSurfacePoints,
      contourToolExtendedPoints: extendedPoints.length,
      contourValidationCheckedSamples: validation.checkedSamples,
      contourValidationScore: validation.score,
      contourValidationUnknownSamples: validation.unknownSamples,
      contourValidationValidSamples: validation.validSamples,
      points: extendedPoints,
      rawContourCandidates: rawContourCandidates.length,
      type: 'pointGridSurface',
      validatedContourCandidates: validatedContourCandidates.length
    };
  });
}
