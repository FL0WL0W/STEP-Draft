import { callAny, dereferenceHandle, enumValue, makeInstance, tryCallAnyArgs } from './occtRuntime.js';

const SIDE_TEST_TOLERANCE = 1e-8;
const ANGLE_TOLERANCE = 1e-5;

function increment(stats, key) {
  if (!stats) {
    return;
  }

  stats[key] = (stats[key] || 0) + 1;
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(vector, amount) {
  return [vector[0] * amount, vector[1] * amount, vector[2] * amount];
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);

  if (length <= 1e-12) {
    return null;
  }

  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function pointKey(point) {
  return [
    Math.round(point[0] * 1e6),
    Math.round(point[1] * 1e6),
    Math.round(point[2] * 1e6)
  ].join(',');
}

function angleOf(vector) {
  return Math.atan2(vector[1], vector[0]);
}

function normalizePositiveAngle(angle) {
  let value = angle;

  while (value < 0) {
    value += Math.PI * 2;
  }

  while (value >= Math.PI * 2) {
    value -= Math.PI * 2;
  }

  return value;
}

function ccwDelta(from, to) {
  return normalizePositiveAngle(to - from);
}

function angleBetweenVectors(left, right) {
  const dot = Math.max(-1, Math.min(1, left[0] * right[0] + left[1] * right[1]));
  return Math.acos(dot);
}

function angleInCcwSector(angle, start, end) {
  return ccwDelta(start, angle) <= ccwDelta(start, end) + ANGLE_TOLERANCE;
}

function edgeIsStraight(oc, edge) {
  try {
    const curve = makeInstance(oc, 'BRepAdaptor_Curve', [edge]);
    const type = callAny(curve, ['GetType']);

    return type === enumValue(oc, 'GeomAbs_CurveType', 'GeomAbs_Line');
  } catch {
    return false;
  }
}

function enumKey(value) {
  if (typeof value === 'number' || typeof value === 'string') {
    return String(value);
  }

  if (typeof value?.value === 'number' || typeof value?.value === 'string') {
    return String(value.value);
  }

  return String(value);
}

function curveTypeName(oc, type) {
  const knownTypes = [
    'GeomAbs_Line',
    'GeomAbs_Circle',
    'GeomAbs_Ellipse',
    'GeomAbs_Hyperbola',
    'GeomAbs_Parabola',
    'GeomAbs_BezierCurve',
    'GeomAbs_BSplineCurve',
    'GeomAbs_OffsetCurve',
    'GeomAbs_OtherCurve'
  ];

  for (const name of knownTypes) {
    if (enumKey(type) === enumKey(enumValue(oc, 'GeomAbs_CurveType', name))) {
      return name.replace('GeomAbs_', '');
    }
  }

  return `rawType:${enumKey(type)}`;
}

function recordBoundaryEdgeCurveType(oc, edge, stats) {
  if (!stats) {
    return;
  }

  if (!stats.boundaryEdgeCurveTypes) {
    stats.boundaryEdgeCurveTypes = {};
  }

  try {
    const curve = makeInstance(oc, 'BRepAdaptor_Curve', [edge]);
    const type = callAny(curve, ['GetType']);
    const key = curveTypeName(oc, type);

    stats.boundaryEdgeCurveTypes[key] = (stats.boundaryEdgeCurveTypes[key] || 0) + 1;
  } catch {
    stats.boundaryEdgeCurveTypes.unreadable = (stats.boundaryEdgeCurveTypes.unreadable || 0) + 1;
  }
}

function upcastToGeomSurfaceHandle(oc, surfaceHandle) {
  try {
    return makeInstance(oc, 'Handle_Geom_Surface', [dereferenceHandle(surfaceHandle)]);
  } catch {
    return surfaceHandle;
  }
}

function projectedTriangleArea(points) {
  const [a, b, c] = points;
  return (
    (b[0] - a[0]) * (c[1] - a[1]) -
    (b[1] - a[1]) * (c[0] - a[0])
  ) * 0.5;
}

function pointInProjectedTriangle(point, triangle) {
  const [a, b, c] = triangle;
  const area = projectedTriangleArea(triangle) * 2;

  if (Math.abs(area) <= SIDE_TEST_TOLERANCE) {
    return false;
  }

  const w1 = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / area;
  const w2 = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / area;
  const w3 = 1 - w1 - w2;

  return w1 >= -SIDE_TEST_TOLERANCE && w2 >= -SIDE_TEST_TOLERANCE && w3 >= -SIDE_TEST_TOLERANCE;
}

function sideCoverageScore(edgeStart, edgeEnd, sideDirection, triangles, offset) {
  if (!triangles || triangles.length === 0) {
    return 0;
  }

  return [0.25, 0.5, 0.75].reduce((score, t) => {
    const sample = [
      edgeStart[0] + (edgeEnd[0] - edgeStart[0]) * t + sideDirection[0] * offset,
      edgeStart[1] + (edgeEnd[1] - edgeStart[1]) * t + sideDirection[1] * offset,
      0
    ];

    return score + (triangles.some((triangle) => pointInProjectedTriangle(sample, triangle)) ? 1 : 0);
  }, 0);
}

function pointCoverageScore(point, direction, triangles, offset) {
  if (!triangles || triangles.length === 0) {
    return 0;
  }

  const sample = [
    point[0] + direction[0] * offset,
    point[1] + direction[1] * offset,
    0
  ];

  return triangles.some((triangle) => pointInProjectedTriangle(sample, triangle)) ? 1 : 0;
}

function outwardDirectionForStraightEdge(edgeStart, edgeEnd, boundaryEdge) {
  const edgeDirection = normalize([edgeEnd[0] - edgeStart[0], edgeEnd[1] - edgeStart[1], 0]);

  if (!edgeDirection) {
    return null;
  }

  const candidates = [
    [-edgeDirection[1], edgeDirection[0], 0],
    [edgeDirection[1], -edgeDirection[0], 0]
  ];
  const edgeLength = Math.hypot(edgeEnd[0] - edgeStart[0], edgeEnd[1] - edgeStart[1]);
  const sideOffset = Math.max(edgeLength * 1e-4, 1e-4);
  const leftCoverage = sideCoverageScore(edgeStart, edgeEnd, candidates[0], boundaryEdge.passingFaceTriangles, sideOffset);
  const rightCoverage = sideCoverageScore(edgeStart, edgeEnd, candidates[1], boundaryEdge.passingFaceTriangles, sideOffset);

  if (leftCoverage !== rightCoverage) {
    return leftCoverage < rightCoverage ? candidates[0] : candidates[1];
  }

  const midpoint = scale(add(edgeStart, edgeEnd), 0.5);
  const towardPassingFace = boundaryEdge.passingFaceCenter
    ? [
      boundaryEdge.passingFaceCenter[0] - midpoint[0],
      boundaryEdge.passingFaceCenter[1] - midpoint[1],
      0
    ]
    : null;

  if (towardPassingFace && Math.hypot(towardPassingFace[0], towardPassingFace[1]) > 1e-9) {
    return candidates[0][0] * towardPassingFace[0] + candidates[0][1] * towardPassingFace[1] < 0
      ? candidates[0]
      : candidates[1];
  }

  return candidates[0];
}

function pointToArray(point) {
  return [
    callAny(point, ['X']),
    callAny(point, ['Y']),
    callAny(point, ['Z'])
  ];
}

function horizontalCircleData(oc, edge) {
  try {
    const curve = makeInstance(oc, 'BRepAdaptor_Curve', [edge]);
    const type = callAny(curve, ['GetType']);

    if (type !== enumValue(oc, 'GeomAbs_CurveType', 'GeomAbs_Circle')) {
      return null;
    }

    const circle = callAny(curve, ['Circle']);
    const position = callAny(circle, ['Position']);
    const direction = pointToArray(callAny(position, ['Direction']));

    if (Math.abs(Math.abs(direction[2]) - 1) > 1e-5) {
      return null;
    }

    return {
      center: pointToArray(callAny(circle, ['Location'])),
      circle,
      direction,
      first: callAny(curve, ['FirstParameter']),
      last: callAny(curve, ['LastParameter']),
      radius: callAny(circle, ['Radius'])
    };
  } catch {
    return null;
  }
}

function nonHorizontalCircleData(oc, edge) {
  try {
    const curve = makeInstance(oc, 'BRepAdaptor_Curve', [edge]);
    const type = callAny(curve, ['GetType']);

    if (type !== enumValue(oc, 'GeomAbs_CurveType', 'GeomAbs_Circle')) {
      return null;
    }

    const circle = callAny(curve, ['Circle']);
    const position = callAny(circle, ['Position']);
    const direction = pointToArray(callAny(position, ['Direction']));

    if (Math.abs(Math.abs(direction[2]) - 1) <= 1e-5) {
      return null;
    }

    return {
      center: pointToArray(callAny(circle, ['Location'])),
      circle,
      direction,
      first: callAny(curve, ['FirstParameter']),
      last: callAny(curve, ['LastParameter']),
      radius: callAny(circle, ['Radius'])
    };
  } catch {
    return null;
  }
}

function ellipseData(oc, edge) {
  try {
    const curve = makeInstance(oc, 'BRepAdaptor_Curve', [edge]);
    const type = callAny(curve, ['GetType']);

    if (type !== enumValue(oc, 'GeomAbs_CurveType', 'GeomAbs_Ellipse')) {
      return null;
    }

    const ellipse = callAny(curve, ['Ellipse']);
    const position = callAny(ellipse, ['Position']);
    const direction = pointToArray(callAny(position, ['Direction']));
    const majorRadius = callAny(ellipse, ['MajorRadius']);
    const minorRadius = callAny(ellipse, ['MinorRadius']);

    return {
      center: pointToArray(callAny(ellipse, ['Location'])),
      direction,
      ellipse,
      first: callAny(curve, ['FirstParameter']),
      kind: 'ellipse',
      last: callAny(curve, ['LastParameter']),
      radius: Math.max(majorRadius, minorRadius)
    };
  } catch {
    return null;
  }
}

function circleFromThreeLocalPoints(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));

  if (Math.abs(d) <= 1e-12) {
    return null;
  }

  const ux = (
    (a[0] * a[0] + a[1] * a[1]) * (b[1] - c[1]) +
    (b[0] * b[0] + b[1] * b[1]) * (c[1] - a[1]) +
    (c[0] * c[0] + c[1] * c[1]) * (a[1] - b[1])
  ) / d;
  const uy = (
    (a[0] * a[0] + a[1] * a[1]) * (c[0] - b[0]) +
    (b[0] * b[0] + b[1] * b[1]) * (a[0] - c[0]) +
    (c[0] * c[0] + c[1] * c[1]) * (b[0] - a[0])
  ) / d;
  const radius = Math.hypot(a[0] - ux, a[1] - uy);

  return Number.isFinite(radius) && radius > 1e-7
    ? { center: [ux, uy], radius }
    : null;
}

function fittedVerticalCircleData(points, stats) {
  if (!points || points.length < 5) {
    increment(stats, 'verticalCircleFitRejectedTooFewPoints');
    return null;
  }

  let minZPoint = points[0];
  let maxZPoint = points[0];

  for (const point of points) {
    if (point[2] < minZPoint[2]) {
      minZPoint = point;
    }

    if (point[2] > maxZPoint[2]) {
      maxZPoint = point;
    }
  }

  let start = null;
  let end = null;
  let bestDistance = 0;

  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const distance = Math.hypot(points[right][0] - points[left][0], points[right][1] - points[left][1]);

      if (distance > bestDistance) {
        bestDistance = distance;
        start = [points[left][0], points[left][1], 0];
        end = [points[right][0], points[right][1], 0];
      }
    }
  }

  if (!start || !end || bestDistance <= 1e-6) {
    increment(stats, 'verticalCircleFitRejectedNoHorizontalSpan');
    return null;
  }

  const axis = normalize([end[0] - start[0], end[1] - start[1], 0]);

  if (!axis) {
    increment(stats, 'verticalCircleFitRejectedNoHorizontalSpan');
    return null;
  }

  const planeTolerance = Math.max(
    Math.hypot(points[points.length - 1][0] - points[0][0], points[points.length - 1][1] - points[0][1]) * 1e-4,
    1e-5
  );

  for (const point of points) {
    const offsetX = point[0] - start[0];
    const offsetY = point[1] - start[1];
    const distanceFromPlane = Math.abs(offsetX * -axis[1] + offsetY * axis[0]);

    if (distanceFromPlane > planeTolerance) {
      increment(stats, 'verticalCircleFitRejectedNotVerticalPlane');
      return null;
    }
  }

  const localPoints = points.map((point) => [
    (point[0] - start[0]) * axis[0] + (point[1] - start[1]) * axis[1],
    point[2]
  ]);
  const localSpread = localPoints.reduce((range, point) => ({
    max: Math.max(range.max, point[0]),
    min: Math.min(range.min, point[0])
  }), { max: Number.NEGATIVE_INFINITY, min: Number.POSITIVE_INFINITY });

  if (localSpread.max - localSpread.min <= 1e-6 || maxZPoint[2] - minZPoint[2] <= 1e-6) {
    increment(stats, 'verticalCircleFitRejectedInsufficientSpread');
    return null;
  }

  const circle = circleFromThreeLocalPoints(
    localPoints[0],
    localPoints[Math.floor(localPoints.length / 2)],
    localPoints[localPoints.length - 1]
  );

  if (!circle) {
    increment(stats, 'verticalCircleFitRejectedNoCircle');
    return null;
  }

  const tolerance = Math.max(circle.radius * 2e-3, 1e-4);

  for (const point of localPoints) {
    if (Math.abs(Math.hypot(point[0] - circle.center[0], point[1] - circle.center[1]) - circle.radius) > tolerance) {
      increment(stats, 'verticalCircleFitRejectedRadialError');
      return null;
    }
  }

  const center = [
    start[0] + axis[0] * circle.center[0],
    start[1] + axis[1] * circle.center[0],
    circle.center[1]
  ];
  const direction = normalize([-axis[1], axis[0], 0]);

  if (!direction) {
    increment(stats, 'verticalCircleFitRejectedNoDirection');
    return null;
  }

  increment(stats, 'verticalCircleFittedCandidates');

  return {
    center,
    direction,
    fitted: true,
    radius: circle.radius
  };
}

function outwardDirectionsForProjectedCurve(boundaryEdge, circleData) {
  const { points } = boundaryEdge;
  const fallbackNormal = normalize([circleData.direction[0], circleData.direction[1], 0]);
  const sideOffset = Math.max((circleData.radius || 1) * 1e-4, 1e-4);
  const baseDirections = [];

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const radial = normalize([
      point[0] - circleData.center[0],
      point[1] - circleData.center[1],
      point[2] - circleData.center[2]
    ]);
    const analyticDirection = radial && Math.abs(circleData.direction[2]) > 1e-5
      ? normalize([
        circleData.direction[0] * radial[2] - radial[0] * circleData.direction[2],
        circleData.direction[1] * radial[2] - radial[1] * circleData.direction[2],
        0
      ])
      : null;
    const radialDirection = normalize([
      point[0] - circleData.center[0],
      point[1] - circleData.center[1],
      0
    ]);

    const baseDirection = analyticDirection || fallbackNormal || radialDirection;

    if (!baseDirection) {
      return null;
    }

    baseDirections.push(baseDirection);
  }

  const positiveCoverage = points.reduce(
    (score, point, index) => score + pointCoverageScore(point, baseDirections[index], boundaryEdge.passingFaceTriangles, sideOffset),
    0
  );
  const negativeCoverage = points.reduce(
    (score, point, index) => score + pointCoverageScore(point, scale(baseDirections[index], -1), boundaryEdge.passingFaceTriangles, sideOffset),
    0
  );

  if (positiveCoverage !== negativeCoverage) {
    const sign = positiveCoverage < negativeCoverage ? 1 : -1;
    return baseDirections.map((direction) => scale(direction, sign));
  }

  if (boundaryEdge.passingFaceCenter) {
    const passingDot = points.reduce((sum, point, index) => {
      const passingSide = [
        boundaryEdge.passingFaceCenter[0] - point[0],
        boundaryEdge.passingFaceCenter[1] - point[1],
        0
      ];

      if (Math.hypot(passingSide[0], passingSide[1]) <= 1e-9) {
        return sum;
      }

      return sum + baseDirections[index][0] * passingSide[0] + baseDirections[index][1] * passingSide[1];
    }, 0);

    if (Math.abs(passingDot) > 1e-9) {
      const sign = passingDot < 0 ? 1 : -1;
      return baseDirections.map((direction) => scale(direction, sign));
    }
  }

  return baseDirections;
}

function circularDraftRadialSign(boundaryEdge, circleData) {
  const { center, radius } = circleData;
  const sideOffset = Math.max((radius || 1) * 1e-4, 1e-4);
  let outwardCoverage = 0;
  let inwardCoverage = 0;
  let sampleCount = 0;

  for (const point of boundaryEdge.points) {
    const radial = normalize([point[0] - center[0], point[1] - center[1], 0]);

    if (!radial) {
      continue;
    }

    outwardCoverage += pointCoverageScore(point, radial, boundaryEdge.passingFaceTriangles, sideOffset);
    inwardCoverage += pointCoverageScore(point, scale(radial, -1), boundaryEdge.passingFaceTriangles, sideOffset);
    sampleCount += 1;
  }

  if (sampleCount === 0) {
    return null;
  }

  if (outwardCoverage !== inwardCoverage) {
    return outwardCoverage < inwardCoverage ? 1 : -1;
  }

  if (boundaryEdge.passingFaceCenter) {
    const midPoint = scale(boundaryEdge.points.reduce((sum, point) => add(sum, point), [0, 0, 0]), 1 / boundaryEdge.points.length);
    const midRadial = normalize([midPoint[0] - center[0], midPoint[1] - center[1], 0]);
    const passingSide = [
      boundaryEdge.passingFaceCenter[0] - center[0],
      boundaryEdge.passingFaceCenter[1] - center[1],
      0
    ];

    if (midRadial && Math.hypot(passingSide[0], passingSide[1]) > 1e-9) {
      return midRadial[0] * passingSide[0] + midRadial[1] * passingSide[1] < 0 ? 1 : -1;
    }
  }

  return 1;
}

function normalizeAngle(angle) {
  let value = angle;

  while (value <= -Math.PI) {
    value += Math.PI * 2;
  }

  while (value > Math.PI) {
    value -= Math.PI * 2;
  }

  return value;
}

function coneUForPoint(point, center) {
  return normalizeAngle(Math.atan2(center[1] - point[1], point[0] - center[0]));
}

function coneUForDirection(direction) {
  return normalizeAngle(Math.atan2(-direction[1], direction[0]));
}

function coneUBoundsFromArcPoints(points, center) {
  const angles = points
    .filter((point) => Math.hypot(point[0] - center[0], point[1] - center[1]) > 1e-7)
    .map((point) => coneUForPoint(point, center));

  if (angles.length < 2) {
    return null;
  }

  const unwrapped = [angles[0]];

  for (let index = 1; index < angles.length; index += 1) {
    let angle = angles[index];
    const previous = unwrapped[index - 1];

    while (angle - previous > Math.PI) {
      angle -= Math.PI * 2;
    }

    while (angle - previous < -Math.PI) {
      angle += Math.PI * 2;
    }

    unwrapped.push(angle);
  }

  const span = unwrapped[unwrapped.length - 1] - unwrapped[0];

  if (Math.abs(span) <= 1e-7) {
    return null;
  }

  return span > 0
    ? { uMin: unwrapped[0], uMax: unwrapped[unwrapped.length - 1] }
    : { uMin: unwrapped[unwrapped.length - 1], uMax: unwrapped[0] };
}

function makeConeAxis(oc, center) {
  const point = makeInstance(oc, 'gp_Pnt', center);
  const direction = makeInstance(oc, 'gp_Dir', [0, 0, -1]);

  try {
    return makeInstance(oc, 'gp_Ax3', [
      point,
      direction,
      makeInstance(oc, 'gp_Dir', [1, 0, 0])
    ]);
  } catch {
    return makeInstance(oc, 'gp_Ax3', [point, direction]);
  }
}

function makeApexConeAxis(oc, apex) {
  const point = makeInstance(oc, 'gp_Pnt', apex);
  const direction = makeInstance(oc, 'gp_Dir', [0, 0, -1]);

  try {
    return makeInstance(oc, 'gp_Ax3', [
      point,
      direction,
      makeInstance(oc, 'gp_Dir', [1, 0, 0])
    ]);
  } catch {
    return makeInstance(oc, 'gp_Ax3', [point, direction]);
  }
}

function makeEdge(oc, start, end) {
  const builder = makeInstance(oc, 'BRepBuilderAPI_MakeEdge', [
    makeInstance(oc, 'gp_Pnt', start),
    makeInstance(oc, 'gp_Pnt', end)
  ]);
  const done = tryCallAnyArgs(builder, ['IsDone'], [[]]);

  if (done.called && !done.value) {
    return null;
  }

  const edge = callAny(builder, ['Edge']);
  return callAny(edge, ['IsNull']) ? null : edge;
}

function makeFaceFromPoints(oc, points) {
  const edges = [];

  for (let index = 0; index < points.length; index += 1) {
    const edge = makeEdge(oc, points[index], points[(index + 1) % points.length]);

    if (!edge) {
      return null;
    }

    edges.push(edge);
  }

  const wireBuilder = makeInstance(oc, 'BRepBuilderAPI_MakeWire');

  for (const edge of edges) {
    callAny(wireBuilder, ['Add_1', 'Add'], [edge]);
  }

  const wireDone = tryCallAnyArgs(wireBuilder, ['IsDone'], [[]]);

  if (wireDone.called && !wireDone.value) {
    return null;
  }

  const wire = callAny(wireBuilder, ['Wire']);
  const faceAttempts = [
    () => makeInstance(oc, 'BRepBuilderAPI_MakeFace', [wire, true]),
    () => makeInstance(oc, 'BRepBuilderAPI_MakeFace', [wire])
  ];

  for (const attempt of faceAttempts) {
    try {
      const faceBuilder = attempt();
      const faceDone = tryCallAnyArgs(faceBuilder, ['IsDone'], [[]]);

      if (faceDone.called && !faceDone.value) {
        continue;
      }

      const face = callAny(faceBuilder, ['Face']);
      return callAny(face, ['IsNull']) ? null : face;
    } catch {
      // Try the next face overload.
    }
  }

  return null;
}

function makeBSplineSurfaceFromPointGrid(oc, pointGrid) {
  const rowCount = pointGrid.length;
  const colCount = pointGrid[0]?.length || 0;

  if (rowCount < 2 || colCount < 2) {
    return null;
  }

  const points = makeInstance(oc, 'TColgp_Array2OfPnt', [1, rowCount, 1, colCount]);

  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      callAny(points, ['SetValue'], [row + 1, col + 1, makeInstance(oc, 'gp_Pnt', pointGrid[row][col])]);
    }
  }

  const attempts = [
    () => makeInstance(oc, 'GeomAPI_PointsToBSplineSurface', [
      points,
      3,
      8,
      enumValue(oc, 'GeomAbs_Shape', 'GeomAbs_C2'),
      1e-4
    ]),
    () => makeInstance(oc, 'GeomAPI_PointsToBSplineSurface', [points])
  ];

  for (const attempt of attempts) {
    try {
      const builder = attempt();

      if (!callAny(builder, ['IsDone'])) {
        continue;
      }

      return upcastToGeomSurfaceHandle(oc, callAny(builder, ['Surface']));
    } catch {
      // Try the next overload.
    }
  }

  return null;
}

function makeSmoothFaceFromPointGrid(oc, pointGrid) {
  const surfaceHandle = makeBSplineSurfaceFromPointGrid(oc, pointGrid);

  if (!surfaceHandle) {
    return null;
  }

  const attempts = [
    () => makeInstance(oc, 'BRepBuilderAPI_MakeFace', [surfaceHandle, 1e-7]),
    () => makeInstance(oc, 'BRepBuilderAPI_MakeFace', [surfaceHandle, true, 1e-7]),
    () => makeInstance(oc, 'BRepBuilderAPI_MakeFace', [surfaceHandle, 0, 1, 0, 1, 1e-7])
  ];

  for (const attempt of attempts) {
    try {
      const builder = attempt();
      const done = tryCallAnyArgs(builder, ['IsDone'], [[]]);

      if (done.called && !done.value) {
        continue;
      }

      const face = callAny(builder, ['Face']);
      return callAny(face, ['IsNull']) ? null : face;
    } catch {
      // Try the next overload.
    }
  }

  return null;
}

function draftedBottomPoint(point, outwardDirection, groundZ, draftAngleDegrees) {
  const height = Math.max(point[2] - groundZ, 0);
  const horizontalOffset = Math.tan((draftAngleDegrees * Math.PI) / 180) * height;

  return [
    point[0] + outwardDirection[0] * horizontalOffset,
    point[1] + outwardDirection[1] * horizontalOffset,
    groundZ
  ];
}

function tangentOrDraftPerpendicular(primaryTangent, draftDirection) {
  const tangent = normalize(primaryTangent);

  if (tangent) {
    return tangent;
  }

  return draftDirection ? normalize([-draftDirection[1], draftDirection[0], 0]) : null;
}

function generateStraightBoundaryFace(oc, boundaryEdge, options) {
  const { draftAngleDegrees, groundZ } = options;
  const { edge, points } = boundaryEdge;

  if (!edgeIsStraight(oc, edge) || points.length < 2 || !Number.isFinite(groundZ)) {
    return null;
  }

  const start = points[0];
  const end = points[points.length - 1];

  if (Math.max(start[2], end[2]) - groundZ <= 1e-7) {
    return null;
  }

  const outwardDirection = outwardDirectionForStraightEdge(start, end, boundaryEdge);

  if (!outwardDirection) {
    return null;
  }

  const draftedEnd = draftedBottomPoint(end, outwardDirection, groundZ, draftAngleDegrees);
  const draftedStart = draftedBottomPoint(start, outwardDirection, groundZ, draftAngleDegrees);
  const face = makeFaceFromPoints(oc, [start, end, draftedEnd, draftedStart]);

  if (!face) {
    return null;
  }

  return {
    endpoints: [
      {
        draftDirection: outwardDirection,
        key: pointKey(start),
        point: start,
        tangent: normalize([end[0] - start[0], end[1] - start[1], 0])
      },
      {
        draftDirection: outwardDirection,
        key: pointKey(end),
        point: end,
        tangent: normalize([start[0] - end[0], start[1] - end[1], 0])
      }
    ],
    face
  };
}

function generateCurvedBoundaryFace(oc, boundaryEdge, options, stats) {
  const { draftAngleDegrees, groundZ } = options;
  increment(stats, 'curvedDraftDetectionAttempts');

  const occtCircleData = nonHorizontalCircleData(oc, boundaryEdge.edge);
  const occtEllipseData = ellipseData(oc, boundaryEdge.edge);

  if (occtCircleData) {
    increment(stats, 'nonHorizontalCircleOcctCandidates');

    if (Math.abs(occtCircleData.direction[2]) <= 1e-5) {
      increment(stats, 'verticalCircleOcctCandidates');
    } else {
      increment(stats, 'tiltedCircleOcctCandidates');
    }
  }

  if (occtEllipseData) {
    increment(stats, 'ellipseOcctCandidates');
  }

  const circleData = occtCircleData || occtEllipseData || fittedVerticalCircleData(boundaryEdge.points, stats);

  if (!circleData) {
    increment(stats, 'curvedDraftRejectedNoCurveData');
    return null;
  }

  increment(stats, 'curvedDraftCandidates');

  if (circleData.kind === 'ellipse') {
    increment(stats, 'ellipseCandidates');
  } else if (Math.abs(circleData.direction[2]) <= 1e-5) {
    increment(stats, 'verticalCircleCandidates');
  } else {
    increment(stats, 'tiltedCircleCandidates');
  }

  if (!Number.isFinite(circleData.radius)) {
    increment(stats, 'curvedDraftRejectedInvalidRadius');
    return null;
  }

  if (!Number.isFinite(groundZ)) {
    increment(stats, 'curvedDraftRejectedInvalidGroundZ');
    return null;
  }

  if (boundaryEdge.points.length < 3) {
    increment(stats, 'curvedDraftRejectedTooFewPoints');
    return null;
  }

  const outwardDirections = outwardDirectionsForProjectedCurve(boundaryEdge, circleData);

  if (!outwardDirections) {
    increment(stats, 'curvedDraftRejectedNoOutwardDirection');
    return null;
  }

  const start = boundaryEdge.points[0];
  const end = boundaryEdge.points[boundaryEdge.points.length - 1];
  const topRow = boundaryEdge.points;
  const bottomRow = topRow.map((point, index) => draftedBottomPoint(point, outwardDirections[index], groundZ, draftAngleDegrees));
  const pointGrid = [0, 1 / 3, 2 / 3, 1].map((t) => topRow.map((point, index) => [
    point[0] + (bottomRow[index][0] - point[0]) * t,
    point[1] + (bottomRow[index][1] - point[1]) * t,
    point[2] + (bottomRow[index][2] - point[2]) * t
  ]));
  const face = makeSmoothFaceFromPointGrid(oc, pointGrid);

  if (!face) {
    increment(stats, 'curvedDraftRejectedNoFace');
    return null;
  }

  const startTangentPoint = topRow[1] || end;
  const endTangentPoint = topRow[topRow.length - 2] || start;
  const startDraftDirection = outwardDirections[0];
  const endDraftDirection = outwardDirections[outwardDirections.length - 1];

  return {
    circleDirection: circleData.direction,
    curveKind: circleData.kind || 'circle',
    endpoints: [
      {
        draftDirection: startDraftDirection,
        key: pointKey(start),
        point: start,
        tangent: tangentOrDraftPerpendicular([
          startTangentPoint[0] - start[0],
          startTangentPoint[1] - start[1],
          0
        ], startDraftDirection)
      },
      {
        draftDirection: endDraftDirection,
        key: pointKey(end),
        point: end,
        tangent: tangentOrDraftPerpendicular([
          endTangentPoint[0] - end[0],
          endTangentPoint[1] - end[1],
          0
        ], endDraftDirection)
      }
    ],
    face
  };
}

function generateHorizontalCircleBoundaryFace(oc, boundaryEdge, options) {
  const { draftAngleDegrees, groundZ } = options;
  const circleData = horizontalCircleData(oc, boundaryEdge.edge);

  if (
    !circleData ||
    !Number.isFinite(circleData.radius) ||
    !Number.isFinite(circleData.center[2]) ||
    !Number.isFinite(groundZ)
  ) {
    return null;
  }

  const height = circleData.center[2] - groundZ;

  if (height <= 1e-7) {
    return null;
  }

  const radialSign = circularDraftRadialSign(boundaryEdge, circleData);

  if (!radialSign) {
    return null;
  }

  const radiusOffset = Math.tan((draftAngleDegrees * Math.PI) / 180) * height * radialSign;
  const bottomRadius = circleData.radius + radiusOffset;

  if (bottomRadius <= 1e-7) {
    return null;
  }

  const uBounds = coneUBoundsFromArcPoints(boundaryEdge.points, circleData.center);

  if (!uBounds) {
    return null;
  }

  const semiAngle = Math.atan2(radiusOffset, height);
  const vMax = height / Math.cos(semiAngle);

  if (!Number.isFinite(semiAngle) || !Number.isFinite(vMax) || Math.abs(vMax) <= 1e-7) {
    return null;
  }

  try {
    const cone = makeInstance(oc, 'gp_Cone', [makeConeAxis(oc, circleData.center), semiAngle, circleData.radius]);
    const builder = makeInstance(oc, 'BRepBuilderAPI_MakeFace', [
      cone,
      uBounds.uMin,
      uBounds.uMax,
      0,
      vMax
    ]);
    const done = tryCallAnyArgs(builder, ['IsDone'], [[]]);

    if (done.called && !done.value) {
      return null;
    }

    const face = callAny(builder, ['Face']);
    if (callAny(face, ['IsNull'])) {
      return null;
    }

    const start = boundaryEdge.points[0];
    const end = boundaryEdge.points[boundaryEdge.points.length - 1];
    const startRadial = normalize([start[0] - circleData.center[0], start[1] - circleData.center[1], 0]);
    const endRadial = normalize([end[0] - circleData.center[0], end[1] - circleData.center[1], 0]);
    const startTangentPoint = boundaryEdge.points[1] || end;
    const endTangentPoint = boundaryEdge.points[boundaryEdge.points.length - 2] || start;

    if (!startRadial || !endRadial) {
      return null;
    }

    const startDraftDirection = scale(startRadial, radialSign);
    const endDraftDirection = scale(endRadial, radialSign);

    return {
      endpoints: [
        {
          draftDirection: startDraftDirection,
          key: pointKey(start),
          point: start,
          tangent: tangentOrDraftPerpendicular([
            startTangentPoint[0] - start[0],
            startTangentPoint[1] - start[1],
            0
          ], startDraftDirection)
        },
        {
          draftDirection: endDraftDirection,
          key: pointKey(end),
          point: end,
          tangent: tangentOrDraftPerpendicular([
            endTangentPoint[0] - end[0],
            endTangentPoint[1] - end[1],
            0
          ], endDraftDirection)
        }
      ],
      face
    };
  } catch {
    return null;
  }
}

function outsideGapInfoForEndpointPair(left, right) {
  const leftTangentAngle = angleOf(left.tangent);
  const rightTangentAngle = angleOf(right.tangent);
  const outsideDirection = normalize(add(left.draftDirection, right.draftDirection)) || left.draftDirection;
  const outsideAngle = angleOf(outsideDirection);
  const ccwTangentSpan = ccwDelta(leftTangentAngle, rightTangentAngle);
  const useLeftToRightSector = angleInCcwSector(outsideAngle, leftTangentAngle, rightTangentAngle);

  return {
    angle: useLeftToRightSector ? ccwTangentSpan : Math.PI * 2 - ccwTangentSpan,
    useLeftToRightSector
  };
}

function coneBoundsFromDraftDirections(leftDirection, rightDirection, useLeftToRightSector) {
  const leftAngle = coneUForDirection(leftDirection);
  const rightAngle = coneUForDirection(rightDirection);
  const start = useLeftToRightSector ? rightAngle : leftAngle;
  const end = useLeftToRightSector ? leftAngle : rightAngle;
  const ccwSpan = ccwDelta(start, end);

  return { uMin: start, uMax: start + ccwSpan };
}

function makeCornerGapFace(oc, left, right, options) {
  const { draftAngleDegrees, groundZ } = options;
  const vertex = left.point;
  const height = vertex[2] - groundZ;

  if (height <= 1e-7) {
    return null;
  }

  const leftDraft = normalize(left.draftDirection);
  const rightDraft = normalize(right.draftDirection);

  if (!leftDraft || !rightDraft) {
    return null;
  }

  const draftAngle = angleBetweenVectors(leftDraft, rightDraft);

  if (Math.abs(Math.PI - draftAngle) <= ANGLE_TOLERANCE || draftAngle <= ANGLE_TOLERANCE) {
    return null;
  }

  const outerGap = outsideGapInfoForEndpointPair(left, right);
  const outerAngle = outerGap.angle;

  if (Math.abs(Math.PI - outerAngle) <= ANGLE_TOLERANCE || outerAngle < Math.PI) {
    return null;
  }

  const radiusOffset = Math.tan((draftAngleDegrees * Math.PI) / 180) * height;

  if (radiusOffset <= 1e-7) {
    return null;
  }

  const semiAngle = Math.atan2(radiusOffset, height);
  const vMax = height / Math.cos(semiAngle);
  const bounds = coneBoundsFromDraftDirections(leftDraft, rightDraft, outerGap.useLeftToRightSector);

  if (!Number.isFinite(semiAngle) || !Number.isFinite(vMax) || Math.abs(bounds.uMax - bounds.uMin) <= ANGLE_TOLERANCE) {
    return null;
  }

  try {
    const cone = makeInstance(oc, 'gp_Cone', [makeApexConeAxis(oc, vertex), semiAngle, 0]);
    const builder = makeInstance(oc, 'BRepBuilderAPI_MakeFace', [
      cone,
      bounds.uMin,
      bounds.uMax,
      0,
      vMax
    ]);
    const done = tryCallAnyArgs(builder, ['IsDone'], [[]]);

    if (done.called && !done.value) {
      return null;
    }

    const face = callAny(builder, ['Face']);
    return callAny(face, ['IsNull']) ? null : face;
  } catch {
    return null;
  }
}

function generateCornerGapFaces(oc, endpointRecords, options) {
  const groups = new Map();
  const faces = [];
  let skipped = 0;

  for (const endpoint of endpointRecords) {
    if (!endpoint?.key || !endpoint?.tangent || !endpoint?.draftDirection) {
      continue;
    }

    if (!groups.has(endpoint.key)) {
      groups.set(endpoint.key, []);
    }

    groups.get(endpoint.key).push(endpoint);
  }

  for (const endpoints of groups.values()) {
    if (endpoints.length < 2) {
      continue;
    }

    const sorted = [...endpoints].sort((left, right) => angleOf(left.tangent) - angleOf(right.tangent));

    for (let index = 0; index < sorted.length; index += 1) {
      const left = sorted[index];
      const right = sorted[(index + 1) % sorted.length];
      const face = makeCornerGapFace(oc, left, right, options);

      if (face) {
        faces.push(face);
      } else {
        skipped += 1;
      }
    }
  }

  return { faces, skipped };
}

export function generateDraftFaces(oc, boundaryEdges, options = {}) {
  const faces = [];
  const endpointRecords = [];
  const stats = {
    boundaryEdgeCurveTypes: {},
    boundaryEdges: boundaryEdges.length,
    generatedConeFaces: 0,
    generatedCurvedDraftFaces: 0,
    generatedCornerGapFaces: 0,
    generatedEllipseFaces: 0,
    generatedNonHorizontalCircleFaces: 0,
    generatedStraightFaces: 0,
    generatedTiltedCircleFaces: 0,
    generatedVerticalCircleFaces: 0,
    skippedCornerGaps: 0,
    skippedEdges: 0
  };

  for (const boundaryEdge of boundaryEdges) {
    recordBoundaryEdgeCurveType(oc, boundaryEdge.edge, stats);

    const curvedFace = generateCurvedBoundaryFace(oc, boundaryEdge, options, stats);

    if (curvedFace) {
      faces.push(curvedFace.face);
      endpointRecords.push(...curvedFace.endpoints.filter((endpoint) => endpoint.tangent));
      stats.generatedCurvedDraftFaces += 1;

      if (curvedFace.curveKind === 'ellipse') {
        stats.generatedEllipseFaces += 1;
      } else {
        stats.generatedNonHorizontalCircleFaces += 1;

        if (Math.abs(curvedFace.circleDirection[2]) <= 1e-5) {
          stats.generatedVerticalCircleFaces += 1;
        } else {
          stats.generatedTiltedCircleFaces += 1;
        }
      }

      continue;
    }

    const straightFace = generateStraightBoundaryFace(oc, boundaryEdge, options);

    if (straightFace) {
      faces.push(straightFace.face);
      endpointRecords.push(...straightFace.endpoints.filter((endpoint) => endpoint.tangent));
      stats.generatedStraightFaces += 1;
      continue;
    }

    const coneFace = generateHorizontalCircleBoundaryFace(oc, boundaryEdge, options);

    if (coneFace) {
      faces.push(coneFace.face);
      endpointRecords.push(...coneFace.endpoints.filter((endpoint) => endpoint.tangent));
      stats.generatedConeFaces += 1;
      continue;
    }

    stats.skippedEdges += 1;
  }

  const cornerGapFaces = generateCornerGapFaces(oc, endpointRecords, options);
  faces.push(...cornerGapFaces.faces);
  stats.generatedCornerGapFaces = cornerGapFaces.faces.length;
  stats.skippedCornerGaps = cornerGapFaces.skipped;

  return { faces, stats };
}
