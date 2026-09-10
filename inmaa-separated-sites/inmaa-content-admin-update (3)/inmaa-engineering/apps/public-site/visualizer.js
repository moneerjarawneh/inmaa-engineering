(() => {
  "use strict";

  const canvas = document.querySelector("#buildingCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: false });
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const model = {
    area: 240,
    floors: 2,
    stoneFacades: 2,
    yaw: -0.72,
    pitch: -0.38,
    zoom: 1,
    width: 3,
    depth: 2.4,
    floorHeight: 0.72,
    autoRotate: !reducedMotion,
    lastFrame: performance.now()
  };

  let cssWidth = 0;
  let cssHeight = 0;
  let pointer = null;
  let needsDraw = true;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssWidth = Math.max(1, rect.width);
    cssHeight = Math.max(1, rect.height);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsDraw = true;
  }

  function rotatePoint(point) {
    const cosY = Math.cos(model.yaw);
    const sinY = Math.sin(model.yaw);
    const x = point.x * cosY - point.z * sinY;
    const z = point.x * sinY + point.z * cosY;
    const cosP = Math.cos(model.pitch);
    const sinP = Math.sin(model.pitch);
    return {
      x,
      y: point.y * cosP - z * sinP,
      depth: point.y * sinP + z * cosP
    };
  }

  function project(point) {
    const rotated = rotatePoint(point);
    const totalHeight = model.floors * model.floorHeight;
    const sceneSpan = Math.max(model.width, model.depth, totalHeight * 0.9, 4.2);
    const scale = (Math.min(cssWidth, cssHeight) / sceneSpan) * 0.62 * model.zoom;
    const perspective = 1 + rotated.depth * 0.018;
    return {
      x: cssWidth * 0.5 + rotated.x * scale * perspective,
      y: cssHeight * 0.58 - (rotated.y - totalHeight * 0.42) * scale * perspective,
      depth: rotated.depth
    };
  }

  function polygon(points, metadata = {}) {
    const projected = points.map(project);
    return {
      ...metadata,
      points: projected,
      depth: projected.reduce((sum, point) => sum + point.depth, 0) / projected.length
    };
  }

  function pathPolygon(points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) {
      ctx.lineTo(points[index].x, points[index].y);
    }
    ctx.closePath();
  }

  function facePoints(face, y0, y1, inset = 0) {
    const halfW = model.width / 2;
    const halfD = model.depth / 2;
    if (face === 0) {
      return [
        { x: -halfW + inset, y: y0, z: -halfD - 0.006 },
        { x: halfW - inset, y: y0, z: -halfD - 0.006 },
        { x: halfW - inset, y: y1, z: -halfD - 0.006 },
        { x: -halfW + inset, y: y1, z: -halfD - 0.006 }
      ];
    }
    if (face === 1) {
      return [
        { x: halfW + 0.006, y: y0, z: -halfD + inset },
        { x: halfW + 0.006, y: y0, z: halfD - inset },
        { x: halfW + 0.006, y: y1, z: halfD - inset },
        { x: halfW + 0.006, y: y1, z: -halfD + inset }
      ];
    }
    if (face === 2) {
      return [
        { x: halfW - inset, y: y0, z: halfD + 0.006 },
        { x: -halfW + inset, y: y0, z: halfD + 0.006 },
        { x: -halfW + inset, y: y1, z: halfD + 0.006 },
        { x: halfW - inset, y: y1, z: halfD + 0.006 }
      ];
    }
    return [
      { x: -halfW - 0.006, y: y0, z: halfD - inset },
      { x: -halfW - 0.006, y: y0, z: -halfD + inset },
      { x: -halfW - 0.006, y: y1, z: -halfD + inset },
      { x: -halfW - 0.006, y: y1, z: halfD - inset }
    ];
  }

  function getSurfaces() {
    const surfaces = [];
    for (let floor = 0; floor < model.floors; floor += 1) {
      const y0 = floor * model.floorHeight;
      const y1 = y0 + model.floorHeight;
      for (let face = 0; face < 4; face += 1) {
        surfaces.push(
          polygon(facePoints(face, y0, y1), {
            kind: "wall",
            face,
            floor,
            stone: face < model.stoneFacades
          })
        );
      }
    }

    const halfW = model.width / 2;
    const halfD = model.depth / 2;
    const roofY = model.floors * model.floorHeight;
    surfaces.push(
      polygon(
        [
          { x: -halfW, y: roofY, z: -halfD },
          { x: halfW, y: roofY, z: -halfD },
          { x: halfW, y: roofY, z: halfD },
          { x: -halfW, y: roofY, z: halfD }
        ],
        { kind: "roof", floor: model.floors }
      )
    );
    return surfaces.sort((a, b) => a.depth - b.depth);
  }

  function wallShade(face, floor) {
    const base = [31, 29, 24];
    const light = [14, 2, -4, 8][face];
    const floorLift = Math.min(floor * 2, 10);
    return `rgb(${base[0] + light + floorLift}, ${base[1] + light + floorLift}, ${base[2] + light + floorLift})`;
  }

  function drawStoneTexture(points, face, floor) {
    ctx.save();
    pathPolygon(points);
    ctx.clip();
    const gradient = ctx.createLinearGradient(0, 0, cssWidth, cssHeight);
    gradient.addColorStop(0, face % 2 === 0 ? "#9b8150" : "#7d6943");
    gradient.addColorStop(0.55, "#b6975b");
    gradient.addColorStop(1, "#685638");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    ctx.strokeStyle = "rgba(28, 23, 15, 0.36)";
    ctx.lineWidth = 0.65;
    const rowHeight = Math.max(8, (maxY - minY) / 6);
    for (let y = minY; y < maxY + rowHeight; y += rowHeight) {
      ctx.beginPath();
      ctx.moveTo(minX - 6, y);
      ctx.lineTo(maxX + 6, y);
      ctx.stroke();
      const offset = Math.round((y / rowHeight + face + floor) % 2) * 9;
      for (let x = minX - offset; x < maxX + 18; x += 20) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 6, y + rowHeight);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawWindows(surface) {
    const face = surface.face;
    const y0 = surface.floor * model.floorHeight + model.floorHeight * 0.22;
    const y1 = surface.floor * model.floorHeight + model.floorHeight * 0.69;
    const isLong = face === 0 || face === 2;
    const count = isLong ? 4 : 3;
    const span = isLong ? model.width : model.depth;
    const halfSpan = span / 2;
    const windowWidth = span / (count * 1.75);

    for (let index = 0; index < count; index += 1) {
      const center = -halfSpan + (span * (index + 0.5)) / count;
      const start = center - windowWidth / 2;
      const end = center + windowWidth / 2;
      let points;
      const halfW = model.width / 2;
      const halfD = model.depth / 2;
      if (face === 0) points = [
        { x: start, y: y0, z: -halfD - 0.012 }, { x: end, y: y0, z: -halfD - 0.012 },
        { x: end, y: y1, z: -halfD - 0.012 }, { x: start, y: y1, z: -halfD - 0.012 }
      ];
      if (face === 2) points = [
        { x: -start, y: y0, z: halfD + 0.012 }, { x: -end, y: y0, z: halfD + 0.012 },
        { x: -end, y: y1, z: halfD + 0.012 }, { x: -start, y: y1, z: halfD + 0.012 }
      ];
      if (face === 1) points = [
        { x: halfW + 0.012, y: y0, z: start }, { x: halfW + 0.012, y: y0, z: end },
        { x: halfW + 0.012, y: y1, z: end }, { x: halfW + 0.012, y: y1, z: start }
      ];
      if (face === 3) points = [
        { x: -halfW - 0.012, y: y0, z: -start }, { x: -halfW - 0.012, y: y0, z: -end },
        { x: -halfW - 0.012, y: y1, z: -end }, { x: -halfW - 0.012, y: y1, z: -start }
      ];
      const projected = points.map(project);
      pathPolygon(projected);
      const glass = ctx.createLinearGradient(projected[0].x, projected[0].y, projected[2].x, projected[2].y);
      glass.addColorStop(0, "#111b1d");
      glass.addColorStop(0.5, "#4b5f5f");
      glass.addColorStop(1, "#152224");
      ctx.fillStyle = glass;
      ctx.fill();
      ctx.strokeStyle = "rgba(241, 210, 139, 0.38)";
      ctx.lineWidth = 0.75;
      ctx.stroke();

      const topMid = {
        x: (projected[2].x + projected[3].x) / 2,
        y: (projected[2].y + projected[3].y) / 2
      };
      const bottomMid = {
        x: (projected[0].x + projected[1].x) / 2,
        y: (projected[0].y + projected[1].y) / 2
      };
      ctx.beginPath();
      ctx.moveTo(topMid.x, topMid.y);
      ctx.lineTo(bottomMid.x, bottomMid.y);
      ctx.strokeStyle = "rgba(241, 210, 139, 0.22)";
      ctx.stroke();
    }
  }

  function drawDoor(surface) {
    if (surface.face !== 0 || surface.floor !== 0) return;
    const halfD = model.depth / 2;
    const points = [
      { x: -0.28, y: 0, z: -halfD - 0.018 },
      { x: 0.28, y: 0, z: -halfD - 0.018 },
      { x: 0.28, y: model.floorHeight * 0.78, z: -halfD - 0.018 },
      { x: -0.28, y: model.floorHeight * 0.78, z: -halfD - 0.018 }
    ].map(project);
    pathPolygon(points);
    ctx.fillStyle = "#17120a";
    ctx.fill();
    ctx.strokeStyle = "rgba(241, 210, 139, 0.64)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawGround() {
    ctx.fillStyle = "#0d0c09";
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const gridSize = 6;
    const step = 0.75;
    ctx.strokeStyle = "rgba(211, 173, 88, 0.075)";
    ctx.lineWidth = 0.7;
    for (let coordinate = -gridSize; coordinate <= gridSize; coordinate += step) {
      const a = project({ x: coordinate, y: 0, z: -gridSize });
      const b = project({ x: coordinate, y: 0, z: gridSize });
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      const c = project({ x: -gridSize, y: 0, z: coordinate });
      const d = project({ x: gridSize, y: 0, z: coordinate });
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
    }

    const shadow = polygon([
      { x: -model.width * 0.62, y: 0.001, z: -model.depth * 0.62 },
      { x: model.width * 0.82, y: 0.001, z: -model.depth * 0.62 },
      { x: model.width * 0.82, y: 0.001, z: model.depth * 0.82 },
      { x: -model.width * 0.62, y: 0.001, z: model.depth * 0.82 }
    ]).points;
    pathPolygon(shadow);
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fill();
  }

  function drawSurface(surface) {
    pathPolygon(surface.points);
    if (surface.kind === "roof") {
      ctx.fillStyle = "#5e4e31";
      ctx.fill();
    } else if (surface.stone) {
      drawStoneTexture(surface.points, surface.face, surface.floor);
    } else {
      ctx.fillStyle = wallShade(surface.face, surface.floor);
      ctx.fill();
    }
    pathPolygon(surface.points);
    ctx.strokeStyle = surface.kind === "roof" ? "rgba(241, 210, 139, 0.66)" : "rgba(211, 173, 88, 0.28)";
    ctx.lineWidth = 0.8;
    ctx.stroke();

    if (surface.kind === "wall") {
      drawWindows(surface);
      drawDoor(surface);
    }
  }

  function draw() {
    drawGround();
    for (const surface of getSurfaces()) drawSurface(surface);

    const roofY = model.floors * model.floorHeight;
    const marker = project({ x: 0, y: roofY + 0.45, z: 0 });
    const top = project({ x: 0, y: roofY, z: 0 });
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(marker.x, marker.y);
    ctx.strokeStyle = "rgba(211, 173, 88, 0.48)";
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    needsDraw = false;
  }

  function frame(now) {
    const delta = Math.min(40, now - model.lastFrame);
    model.lastFrame = now;
    if (model.autoRotate && !pointer) {
      model.yaw += delta * 0.00012;
      needsDraw = true;
    }
    if (needsDraw) draw();
    requestAnimationFrame(frame);
  }

  function update(payload = {}) {
    if (Number.isFinite(Number(payload.area))) model.area = clamp(Number(payload.area), 40, 50000);
    if (Number.isFinite(Number(payload.floors))) model.floors = clamp(Math.round(Number(payload.floors)), 1, 12);
    if (Number.isFinite(Number(payload.stoneFacades))) model.stoneFacades = clamp(Math.round(Number(payload.stoneFacades)), 0, 4);

    const floorArea = model.area / model.floors;
    const rawWidth = Math.sqrt(floorArea * 1.25);
    const rawDepth = floorArea / rawWidth;
    const maxSide = Math.max(rawWidth, rawDepth);
    model.width = 3.15 * (rawWidth / maxSide);
    model.depth = 3.15 * (rawDepth / maxSide);
    model.floorHeight = clamp(2.8 / Math.max(model.floors, 3), 0.42, 0.78);
    needsDraw = true;
  }

  canvas.addEventListener("pointerdown", (event) => {
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    model.autoRotate = false;
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    model.yaw += dx * 0.008;
    model.pitch = clamp(model.pitch - dy * 0.006, -0.82, -0.12);
    needsDraw = true;
  });

  function releasePointer(event) {
    if (pointer && event.pointerId === pointer.id) pointer = null;
  }
  canvas.addEventListener("pointerup", releasePointer);
  canvas.addEventListener("pointercancel", releasePointer);

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      model.zoom = clamp(model.zoom - event.deltaY * 0.001, 0.7, 1.55);
      model.autoRotate = false;
      needsDraw = true;
    },
    { passive: false }
  );

  document.querySelectorAll("[data-view-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.viewAction;
      if (action === "zoom-in") model.zoom = clamp(model.zoom + 0.12, 0.7, 1.55);
      if (action === "zoom-out") model.zoom = clamp(model.zoom - 0.12, 0.7, 1.55);
      if (action === "reset") {
        model.yaw = -0.72;
        model.pitch = -0.38;
        model.zoom = 1;
        model.autoRotate = false;
      }
      if (action === "rotate") model.autoRotate = !model.autoRotate;
      needsDraw = true;
    });
  });

  new ResizeObserver(resize).observe(canvas);
  window.InmaaVisualizer = { update };
  resize();
  update();
  requestAnimationFrame(frame);
})();
