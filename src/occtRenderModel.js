const RENDER_LINEAR_DEFLECTION = 0.025;
const RENDER_ANGULAR_DEFLECTION = 0.15;

function cleanTriangulation(oc, shape, helpers) {
  helpers.tryCallAnyArgs(oc.BRepTools, ['Clean'], [[shape, true], [shape]]);
}

function triangulateShape(oc, shape, helpers) {
  const mesher = helpers.makeInstance(oc, 'BRepMesh_IncrementalMesh', [
    shape,
    RENDER_LINEAR_DEFLECTION,
    false,
    RENDER_ANGULAR_DEFLECTION,
    true
  ]);

  if (typeof mesher.Perform === 'function') {
    mesher.Perform(helpers.makeInstance(oc, 'Message_ProgressRange'));
  }
}

function transformPoint(point, transform, helpers) {
  if (!transform) {
    return point;
  }

  try {
    return helpers.callAny(point, ['Transformed'], [transform]);
  } catch {
    helpers.callAny(point, ['Transform'], [transform]);
    return point;
  }
}

function normalizeVector(nx, ny, nz) {
  const length = Math.hypot(nx, ny, nz);

  if (length === 0) {
    return { nx: 0, ny: 0, nz: 1 };
  }

  return { nx: nx / length, ny: ny / length, nz: nz / length };
}

function transformNormal(oc, normal, transform, helpers) {
  if (!transform) {
    return normal;
  }

  const vector = helpers.makeInstance(oc, 'gp_Vec', [normal.nx, normal.ny, normal.nz]);
  const transformed = helpers.callAny(vector, ['Transformed'], [transform]);
  return normalizeVector(
    helpers.getCoord(transformed, 'X'),
    helpers.getCoord(transformed, 'Y'),
    helpers.getCoord(transformed, 'Z')
  );
}

function triangulationForFace(oc, face, helpers) {
  const location = helpers.makeInstance(oc, 'TopLoc_Location');
  const purposeCandidates = [
    helpers.enumValue(oc, 'Poly_MeshPurpose', 'Poly_MeshPurpose_NONE'),
    helpers.enumValue(oc, 'Poly_MeshPurpose', 'Poly_MeshPurpose_Shading'),
    helpers.enumValue(oc, 'Poly_MeshPurpose', 'Poly_MeshPurpose_AnyFallback'),
    0,
    2,
    0xffff
  ];
  const seenPurposes = new Set();
  const errors = [];

  for (const candidate of purposeCandidates) {
    const meshPurpose = helpers.statusValue(candidate);

    if (!Number.isFinite(meshPurpose) || seenPurposes.has(meshPurpose)) {
      continue;
    }

    seenPurposes.add(meshPurpose);

    try {
      const triangulationHandle = oc.BRep_Tool.Triangulation(face, location, meshPurpose);

      if (triangulationHandle && !helpers.callAny(triangulationHandle, ['IsNull'])) {
        const triangulation = helpers.dereferenceHandle(triangulationHandle);
        const transform = helpers.callAny(location, ['Transformation']);
        return { triangulation, transform };
      }
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  if (errors.length > 0) {
    throw new Error(`OpenCascade could not access face triangulation: ${errors.join(' | ')}`);
  }

  return null;
}

function triangleVertexIndex(triangle, localIndex) {
  if (typeof triangle.Value === 'function') {
    return triangle.Value(localIndex);
  }

  if (typeof triangle.Get === 'function') {
    return triangle.Get(localIndex);
  }

  return triangle[localIndex - 1];
}

function normalFromFaceSurface(oc, surface, triangulation, nodeIndex, forward, transform, helpers) {
  if (!helpers.callAny(triangulation, ['HasUVNodes'])) {
    throw new Error('OpenCascade triangulation has no UV nodes for analytic surface normal evaluation.');
  }

  const uv = helpers.callAny(triangulation, ['UVNode'], [nodeIndex]);
  const normal = helpers.normalFromDerivatives(
    oc,
    surface,
    helpers.callAny(uv, ['X']),
    helpers.callAny(uv, ['Y']),
    forward
  );
  return transformNormal(oc, normal, transform, helpers);
}

function appendFaceTriangulation(oc, face, output, helpers) {
  const data = triangulationForFace(oc, face, helpers);

  if (!data) {
    return null;
  }

  const { triangulation, transform } = data;
  const vertexOffset = output.positions.length / 3;
  const triangleOffset = output.indices.length / 3;
  const nodeCount = helpers.callAny(triangulation, ['NbNodes']);
  const triangleCount = helpers.callAny(triangulation, ['NbTriangles']);
  const reversed = helpers.shapeOrientation(face) === helpers.enumValue(oc, 'TopAbs_Orientation', 'TopAbs_REVERSED');
  const forward = !reversed;
  const surface = helpers.makeInstance(oc, 'BRepAdaptor_Surface', [face, true]);

  for (let nodeIndex = 1; nodeIndex <= nodeCount; nodeIndex += 1) {
    const point = transformPoint(helpers.callAny(triangulation, ['Node'], [nodeIndex]), transform, helpers);
    const normal = normalFromFaceSurface(oc, surface, triangulation, nodeIndex, forward, transform, helpers);

    output.positions.push(
      helpers.getCoord(point, 'X'),
      helpers.getCoord(point, 'Y'),
      helpers.getCoord(point, 'Z')
    );
    output.normals.push(normal.nx, normal.ny, normal.nz);
  }

  for (let triangleIndex = 1; triangleIndex <= triangleCount; triangleIndex += 1) {
    const triangle = helpers.callAny(triangulation, ['Triangle'], [triangleIndex]);
    const a = vertexOffset + triangleVertexIndex(triangle, 1) - 1;
    const b = vertexOffset + triangleVertexIndex(triangle, 2) - 1;
    const c = vertexOffset + triangleVertexIndex(triangle, 3) - 1;

    if (reversed) {
      output.indices.push(a, c, b);
    } else {
      output.indices.push(a, b, c);
    }
  }

  return {
    first: triangleOffset,
    last: triangleOffset + triangleCount - 1
  };
}

function normalFailsDraftRule(nz, draftAngleDegrees) {
  if (nz < 0) {
    return true;
  }

  const draftFromVertical = (Math.asin(Math.min(Math.max(Math.abs(nz), 0), 1)) * 180) / Math.PI;
  return draftFromVertical < draftAngleDegrees;
}

function faceFailsDraftRule(oc, face, draftAngleDegrees, helpers) {
  let surface;

  try {
    surface = helpers.makeInstance(oc, 'BRepAdaptor_Surface', [face, true]);
  } catch {
    return false;
  }

  const uFirst = helpers.callAny(surface, ['FirstUParameter']);
  const uLast = helpers.callAny(surface, ['LastUParameter']);
  const vFirst = helpers.callAny(surface, ['FirstVParameter']);
  const vLast = helpers.callAny(surface, ['LastVParameter']);

  if (![uFirst, uLast, vFirst, vLast].every(Number.isFinite) || uLast <= uFirst || vLast <= vFirst) {
    return false;
  }

  const forward = helpers.shapeOrientation(face) !== helpers.enumValue(oc, 'TopAbs_Orientation', 'TopAbs_REVERSED');
  const uvSamples = [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.25, 0.5],
    [0.25, 0.75],
    [0.5, 0.25],
    [0.5, 0.75],
    [0.75, 0.25],
    [0.75, 0.5],
    [0.75, 0.75]
  ];
  let failingSamples = 0;
  let passingSamples = 0;

  for (const [uRatio, vRatio] of uvSamples) {
    const u = uFirst + (uLast - uFirst) * uRatio;
    const v = vFirst + (vLast - vFirst) * vRatio;

    try {
      const normal = helpers.normalFromDerivatives(oc, surface, u, v, forward);

      if (normalFailsDraftRule(normal.nz, draftAngleDegrees)) {
        failingSamples += 1;
      } else {
        passingSamples += 1;
      }
    } catch {
      // Keep going; trimmed or singular regions can reject some sample points.
    }
  }

  if (failingSamples === 0 && passingSamples === 0) {
    return false;
  }

  return failingSamples >= passingSamples;
}

function distanceBetween(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function distanceToSegment(point, start, end) {
  const vx = end[0] - start[0];
  const vy = end[1] - start[1];
  const vz = end[2] - start[2];
  const wx = point[0] - start[0];
  const wy = point[1] - start[1];
  const wz = point[2] - start[2];
  const lengthSquared = vx * vx + vy * vy + vz * vz;

  if (lengthSquared <= 1e-18) {
    return distanceBetween(point, start);
  }

  const t = Math.min(Math.max((wx * vx + wy * vy + wz * vz) / lengthSquared, 0), 1);
  return Math.hypot(
    point[0] - (start[0] + vx * t),
    point[1] - (start[1] + vy * t),
    point[2] - (start[2] + vz * t)
  );
}

function sampleEdgeCurve(oc, edge, helpers) {
  const curve = helpers.makeInstance(oc, 'BRepAdaptor_Curve', [edge]);
  const first = helpers.callAny(curve, ['FirstParameter']);
  const last = helpers.callAny(curve, ['LastParameter']);

  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return [];
  }

  const maxDepth = 14;
  const chordTolerance = 0.015;
  const minParameterSpan = Math.max(Math.abs(last - first) * 1e-8, 1e-9);
  const points = [];

  function valueAt(t) {
    return helpers.pointToArray(helpers.callAny(curve, ['Value'], [t]));
  }

  function appendAdaptive(t0, p0, t1, p1, depth) {
    const tm = (t0 + t1) * 0.5;
    const pm = valueAt(tm);
    const chordError = distanceToSegment(pm, p0, p1);
    const segmentLength = distanceBetween(p0, p1);

    if (
      depth >= maxDepth ||
      Math.abs(t1 - t0) <= minParameterSpan ||
      (chordError <= chordTolerance && segmentLength <= chordTolerance * 80)
    ) {
      points.push(p1);
      return;
    }

    appendAdaptive(t0, p0, tm, pm, depth + 1);
    appendAdaptive(tm, pm, t1, p1, depth + 1);
  }

  const firstPoint = valueAt(first);
  const lastPoint = valueAt(last);
  points.push(firstPoint);
  appendAdaptive(first, firstPoint, last, lastPoint, 0);

  return points.flat();
}

function collectBoundaryLines(oc, shape, helpers) {
  const positions = [];
  const edgeKeys = new Set();
  const explorer = helpers.makeExplorer(oc, shape, helpers.enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_EDGE'));

  for (; helpers.callAny(explorer, ['More']); helpers.callAny(explorer, ['Next'])) {
    const edge = helpers.edgeFromExplorer(oc, explorer);
    const edgeHash = typeof edge.HashCode === 'function' ? edge.HashCode(1000000007) : null;

    if (edgeHash !== null && edgeKeys.has(edgeHash)) {
      continue;
    }

    if (edgeHash !== null) {
      edgeKeys.add(edgeHash);
    }

    const edgePositions = sampleEdgeCurve(oc, edge, helpers);

    for (let index = 0; index + 5 < edgePositions.length; index += 3) {
      positions.push(
        edgePositions[index],
        edgePositions[index + 1],
        edgePositions[index + 2],
        edgePositions[index + 3],
        edgePositions[index + 4],
        edgePositions[index + 5]
      );
    }
  }

  return positions;
}

export function buildRenderModelFromShape(oc, shape, splitResult, splitStepText = null, options = {}, helpers) {
  cleanTriangulation(oc, shape, helpers);
  triangulateShape(oc, shape, helpers);

  const output = {
    positions: [],
    normals: [],
    indices: [],
    brep_faces: [],
    failedFaceIndices: new Set(),
    mixedFaceIndices: new Set(),
    edgePositions: []
  };

  const explorer = helpers.makeExplorer(oc, shape, helpers.enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE'));
  let faceIndex = 0;

  for (; helpers.callAny(explorer, ['More']); helpers.callAny(explorer, ['Next'])) {
    const face = helpers.faceFromExplorer(oc, explorer);
    const range = appendFaceTriangulation(oc, face, output, helpers);

    if (range) {
      output.brep_faces.push({ ...range, faceIndex });

      if (options.classifyDraftFaces && faceFailsDraftRule(oc, face, options.draftAngleDegrees ?? 3, helpers)) {
        output.failedFaceIndices.add(faceIndex);
      }
    }

    faceIndex += 1;
  }

  if (faceIndex === 0) {
    throw new Error('OpenCascade imported the STEP file, but found no BRep faces.');
  }

  if (output.positions.length === 0 || output.indices.length === 0) {
    throw new Error('OpenCascade imported BRep faces, but produced no triangulation for rendering.');
  }

  output.edgePositions = collectBoundaryLines(oc, shape, helpers);

  return {
    meshes: [
      {
        name: 'STEP body',
        color: [0.78, 0.8, 0.82],
        attributes: {
          position: {
            array: output.positions
          },
          normal: {
            array: output.normals
          }
        },
        index: {
          array: output.indices
        },
        brep_faces: output.brep_faces,
        edgePositions: output.edgePositions,
        faceDraftClassification: Boolean(options.classifyDraftFaces)
      }
    ],
    failedFaceIndices: output.failedFaceIndices,
    mixedFaceIndices: output.mixedFaceIndices,
    splitDiagnostics: splitResult.diagnostics,
    splitStepText,
    totalFaces: faceIndex
  };
}
