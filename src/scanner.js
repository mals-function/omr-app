import { questions } from './model';

export const WIDTH = 1200;
export const HEIGHT = 1700;

export const MARKERS = [
  { x: 50, y: 50 },
  { x: 1150, y: 50 },
  { x: 1150, y: 1650 },
  { x: 50, y: 1650 }
];

function position(index, optionIndex = 0) {
  const column = Math.floor(index / 25);
  const row = index % 25;

  return {
    x: 210 + column * 550 + optionIndex * 70,
    y: 260 + row * 48
  };
}

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, character => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;'
  }[character]));
}

export function sheetSvg(exam) {
  const items = questions(exam);

  const rows = items.map((item, index) => {
    const point = position(index);

    const bubbles = item.options.map((option, optionIndex) => {
      const p = position(index, optionIndex);

      return `
        <circle
          cx="${p.x}"
          cy="${p.y}"
          r="13"
          fill="white"
          stroke="black"
          stroke-width="2"
        />
        <text x="${p.x + 20}" y="${p.y + 6}">
          ${option}
        </text>
      `;
    }).join('');

    return `
      <text x="${point.x - 75}" y="${point.y + 6}">
        ${index + 1}.
      </text>
      ${bubbles}
    `;
  }).join('');

  let start = 1;

  const sectionLabels = exam.sections.map(section => {
    const end = start + section.key.length - 1;
    const text = `${section.name}: ${start}–${end}`;
    start = end + 1;
    return text;
  });

  return `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${WIDTH}"
      height="${HEIGHT}"
      viewBox="0 0 ${WIDTH} ${HEIGHT}"
    >
      <rect width="${WIDTH}" height="${HEIGHT}" fill="white"/>

      ${MARKERS.map(p => `
        <rect
          x="${p.x - 10}"
          y="${p.y - 10}"
          width="20"
          height="20"
          fill="black"
        />
      `).join('')}

      <g font-family="Arial" fill="black" font-size="20">
        <text x="100" y="110" font-size="28">
          ${escapeXml(exam.title.slice(0, 60))}
        </text>

        <text x="100" y="155">
          Name: _________________________________
        </text>

        <text x="100" y="195">
          Student number: _______________________
        </text>

        ${rows}

        ${sectionLabels.map((text, index) => `
          <text x="100" y="${1500 + index * 25}">
            ${escapeXml(text.slice(0, 90))}
          </text>
        `).join('')}

        <text x="100" y="1660" font-size="15">
          OMR-V2 | ${escapeXml(exam.id)} | Keep all four markers visible.
        </text>
      </g>
    </svg>
  `;
}

let cvPromise;

export function loadOpenCv() {
  if (cvPromise) return cvPromise;

  cvPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/opencv.js';

    let interval;

    const fail = () => {
      clearInterval(interval);
      clearTimeout(timeout);
      script.remove();
      cvPromise = undefined;
      reject(new Error('OpenCV failed to load. Reinstall dependencies.'));
    };

    const timeout = setTimeout(fail, 30000);

    script.onerror = fail;

    script.onload = () => {
      interval = setInterval(async () => {
        try {
          const raw = window.cv;
          if (!raw) return;

          const cv = typeof raw.then === 'function' ? await raw : raw;

          if (!cv.Mat) return;

          clearInterval(interval);
          clearTimeout(timeout);
          resolve(cv);
        } catch {
          fail();
        }
      }, 100);
    };

    document.head.appendChild(script);
  });

  return cvPromise;
}

export async function loadImage(url) {
  const image = new Image();

  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('Use a valid JPG or PNG image.'));
    image.src = url;
  });

  const scale = Math.min(
    1,
    2200 / Math.max(image.naturalWidth, image.naturalHeight)
  );

  const canvas = document.createElement('canvas');

  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);

  canvas.getContext('2d').drawImage(
    image,
    0,
    0,
    canvas.width,
    canvas.height
  );

  return canvas;
}

function validateCorners(points, canvas) {
  if (
    points.length !== 4 ||
    points.some(p =>
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      p.x < 0 ||
      p.y < 0 ||
      p.x > canvas.width ||
      p.y > canvas.height
    )
  ) {
    throw new Error('Select four marker centers inside the image.');
  }

  const crossProducts = points.map((p, index) => {
    const next = points[(index + 1) % 4];
    const after = points[(index + 2) % 4];

    return (
      (next.x - p.x) * (after.y - next.y) -
      (next.y - p.y) * (after.x - next.x)
    );
  });

  const area = Math.abs(points.reduce((sum, p, index) => {
    const next = points[(index + 1) % 4];
    return sum + p.x * next.y - next.x * p.y;
  }, 0)) / 2;

  if (
    crossProducts.some(value => value <= 0) ||
    area < canvas.width * canvas.height * 0.1
  ) {
    throw new Error(
      'Tap top-left, top-right, bottom-right, bottom-left. ' +
      'Retake if the sheet is too small.'
    );
  }
}

function classify(ratios, options) {
  const marked = ratios
    .map((value, index) => ({ value, index }))
    .filter(item => item.value >= 0.5);

  if (marked.length > 1) return 'MULTIPLE';

  if (!marked.length) {
    return Math.max(...ratios) > 0.15 ? '?' : '';
  }

  const winner = marked[0];

  const second = Math.max(
    ...ratios.filter((_, index) => index !== winner.index)
  );

  if (winner.value < 0.65 || second > 0.2) return '?';

  return options[winner.index];
}

export async function scanSheet(canvas, points, exam) {
  validateCorners(points, canvas);

  const cv = await loadOpenCv();
  const allocated = [];

  const keep = value => {
    allocated.push(value);
    return value;
  };

  try {
    const source = keep(cv.imread(canvas));
    const aligned = keep(new cv.Mat());
    const gray = keep(new cv.Mat());
    const binary = keep(new cv.Mat());

    const from = keep(cv.matFromArray(
      4,
      1,
      cv.CV_32FC2,
      points.flatMap(p => [p.x, p.y])
    ));

    const to = keep(cv.matFromArray(
      4,
      1,
      cv.CV_32FC2,
      MARKERS.flatMap(p => [p.x, p.y])
    ));

    const transform = keep(cv.getPerspectiveTransform(from, to));

    cv.warpPerspective(
      source,
      aligned,
      transform,
      new cv.Size(WIDTH, HEIGHT),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255)
    );

    cv.cvtColor(aligned, gray, cv.COLOR_RGBA2GRAY);

    cv.threshold(
      gray,
      binary,
      0,
      255,
      cv.THRESH_BINARY_INV | cv.THRESH_OTSU
    );

    const items = questions(exam);

    const answers = items.map((item, questionIndex) => {
      const ratios = item.options.map((_, optionIndex) => {
        const center = position(questionIndex, optionIndex);

        let dark = 0;
        let total = 0;

        for (let dy = -8; dy <= 8; dy++) {
          for (let dx = -8; dx <= 8; dx++) {
            if (dx * dx + dy * dy > 64) continue;

            total++;

            const index =
              (center.y + dy) * WIDTH + center.x + dx;

            if (binary.data[index] > 0) dark++;
          }
        }

        return dark / total;
      });

      return classify(ratios, item.options);
    });

    const preview = document.createElement('canvas');
    cv.imshow(preview, aligned);

    const context = preview.getContext('2d');
    context.lineWidth = 3;

    answers.forEach((answer, index) => {
      const choiceIndex = items[index].options.indexOf(answer);
      const p = position(index, Math.max(0, choiceIndex));

      if (choiceIndex >= 0) {
        context.strokeStyle = '#008000';
        context.beginPath();
        context.arc(p.x, p.y, 19, 0, Math.PI * 2);
        context.stroke();
      } else {
        context.strokeStyle = '#c25e00';
        context.strokeRect(p.x - 85, p.y - 22, 370, 44);
      }
    });

    return {
      answers,
      preview: preview.toDataURL('image/jpeg', 0.9)
    };
  } finally {
    allocated.reverse().forEach(value => value.delete());
  }
}

export async function detectCorners(canvas) {
  const cv = await loadOpenCv();
  const allocated = [];
  const keep = value => {
    allocated.push(value);
    return value;
  };

  try {
    const source = keep(cv.imread(canvas));
    const gray = keep(new cv.Mat());
    const binary = keep(new cv.Mat());
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();

    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, binary, 80, 255, cv.THRESH_BINARY_INV);
    cv.findContours(
      binary,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );

    const candidates = [];

    for (let index = 0; index < contours.size(); index++) {
      const contour = contours.get(index);
      const perimeter = cv.arcLength(contour, true);
      const polygon = new cv.Mat();

      cv.approxPolyDP(contour, polygon, perimeter * 0.04, true);

      if (
        polygon.rows === 4 &&
        cv.contourArea(polygon) >= 150 &&
        cv.contourArea(polygon) <= 3000
      ) {
        const bounds = cv.boundingRect(polygon);
        const ratio = bounds.width / bounds.height;

        if (ratio > 0.65 && ratio < 1.5) {
          candidates.push({
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
            area: bounds.width * bounds.height
          });
        }
      }

      polygon.delete();
      contour.delete();
    }

    contours.delete();
    hierarchy.delete();

    const unique = candidates
      .sort((left, right) => right.area - left.area)
      .filter((point, index, all) =>
        all.slice(0, index).every(previous =>
          Math.hypot(point.x - previous.x, point.y - previous.y) > 25
        )
      )
      .slice(0, 4);

    if (unique.length !== 4) return [];

    const top = unique
      .filter(point => point.y < canvas.height / 2)
      .sort((left, right) => left.x - right.x);
    const bottom = unique
      .filter(point => point.y >= canvas.height / 2)
      .sort((left, right) => right.x - left.x);

    return top.length === 2 && bottom.length === 2
      ? [...top, ...bottom]
      : [];
  } finally {
    allocated.reverse().forEach(value => value.delete());
  }
}