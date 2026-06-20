import { callAny, enumValue, makeInstance, tryCallAnyArgs } from './occtRuntime.js';

const LINE_TOLERANCE = 1e-5;
const SIDE_TEST_TOLERANCE = 1e-8;

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

function projectedDistanceToSegment(point, start, end) {
  const vx = end[0] - start[0];
  const vy = end[1] - start[1];
  const wx = point[0] - start[0];
  const wy = point[1] - start[1];
  const lengthSquared = vx * vx + vy * vy;

  if (lengthSquared <= 1e-18) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }

  const t = Math.min(Math.max((wx * vx + wy * vy) / lengthSquared, 0), 1);
  return Math.hypot(
    point[0] - (start[0] + vx * t),
    point[1] - (start[1] + vy * t)
  );
}

function lineLikePoints(points) {
  if (!points || points.length < 2) {
    return false;
  }

  const start = points[0];
  const end = points[points.length - 1];
  const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
  const tolerance = Math.max(LINE_TOLERANCE, length * 1e-5);

  return points.every((point) => projectedDistanceToSegment(point, start, end) <= tolerance);
}

function edgeIsStraight(oc, edge, points) {
  try {
    const curve = makeInstance(oc, 'BRepAdaptor_Curve', [edge]);
    const type = callAny(curve, ['GetType']);

    if (type === enumValue(oc, 'GeomAbs_CurveType', 'GeomAbs_Line')) {
      return true;
    }
  } catch {
    // Fall back to sampled geometry.
  }

  return lineLikePoints(points);
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

function draftedBottomPoint(point, outwardDirection, groundZ, draftAngleDegrees) {
  const height = Math.max(point[2] - groundZ, 0);
  const horizontalOffset = Math.tan((draftAngleDegrees * Math.PI) / 180) * height;

  return [
    point[0] + outwardDirection[0] * horizontalOffset,
    point[1] + outwardDirection[1] * horizontalOffset,
    groundZ
  ];
}

function generateStraightBoundaryFace(oc, boundaryEdge, options) {
  const { draftAngleDegrees, groundZ } = options;
  const { edge, points } = boundaryEdge;

  if (!edgeIsStraight(oc, edge, points) || points.length < 2 || !Number.isFinite(groundZ)) {
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
  return makeFaceFromPoints(oc, [start, end, draftedEnd, draftedStart]);
}

export function generateDraftFaces(oc, boundaryEdges, options = {}) {
  const faces = [];
  const stats = {
    boundaryEdges: boundaryEdges.length,
    generatedStraightFaces: 0,
    skippedEdges: 0
  };

  for (const boundaryEdge of boundaryEdges) {
    const face = generateStraightBoundaryFace(oc, boundaryEdge, options);

    if (face) {
      faces.push(face);
      stats.generatedStraightFaces += 1;
    } else {
      stats.skippedEdges += 1;
    }
  }

  return { faces, stats };
}
