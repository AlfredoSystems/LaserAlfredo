import { expect, test, type Page } from '@playwright/test';

/** 100 × 50 mm rectangle from four blue LINEs plus a red circle, R12 style. */
function sampleDxf(): string {
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    ['0', 'LINE', '8', '0', '62', '5', '10', x1, '20', y1, '11', x2, '21', y2].join('\n');
  return [
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    line(0, 0, 100, 0),
    line(100, 0, 100, 50),
    line(100, 50, 0, 50),
    line(0, 50, 0, 0),
    ['0', 'CIRCLE', '8', '0', '62', '1', '10', 50, '20', 25, '40', 10].join('\n'),
    '0',
    'ENDSEC',
    '0',
    'EOF',
    '',
  ].join('\n');
}

const SAMPLE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">' +
  '<rect x="0" y="0" width="40" height="20" stroke="#00a000" fill="none"/></svg>';

/** A 120 × 80 mm rectangle with a small one inside it, away from the bed corner so it keeps its place. */
const SECOND_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="600mm" viewBox="0 0 1000 600">' +
  '<rect x="300" y="200" width="120" height="80" stroke="#000000" fill="none"/>' +
  '<rect x="340" y="230" width="40" height="20" stroke="#000000" fill="none"/></svg>';

async function importSample(page: Page, name: string, content: string) {
  await page.getByTestId('file-input').setInputFiles({
    name,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(content),
  });
}

/** Screen position of a document point, assuming the initial "fit bed" view. */
async function bedPoint(page: Page, xMm: number, yMm: number) {
  const box = await page.getByTestId('workspace-canvas').boundingBox();
  if (!box) throw new Error('canvas not laid out');
  const scale = Math.min((box.width - 80) / 1000, (box.height - 80) / 600);
  return {
    x: box.x + box.width / 2 + (xMm - 500) * scale,
    y: box.y + box.height / 2 + (yMm - 300) * scale,
    scale,
  };
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'LaserAlfredo' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('app loads and shows the bed size', async ({ page }) => {
  await expect(page.getByTestId('bed-size')).toHaveText('Bed 1000 × 600 mm');
  await expect(page.getByTestId('shape-count')).toHaveText('0 shapes');
});

test('imports a DXF, joins lines and creates layers by colour', async ({ page }) => {
  await page.getByTestId('keep-colors').check();
  await importSample(page, 'sample.dxf', sampleDxf());
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');
  await expect(page.getByTestId('notice')).toContainText('2 shapes (2 closed)');
  await expect(page.getByTestId('layer-row')).toHaveCount(2);
  await expect(page.getByTestId('selection-count')).toHaveText('2');
  await expect(page.getByTestId('sel-x')).toHaveValue('0');
  await expect(page.getByTestId('sel-w')).toHaveValue('100');
  await expect(page.getByTestId('sel-h')).toHaveValue('50');
});

test('imports onto the active layer by default', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');
  await expect(page.getByTestId('layer-row')).toHaveCount(1);

  // Pick red as the active layer with nothing selected: the next import lands there.
  await page.keyboard.press('Escape');
  await page.getByTestId('palette-ff0000').click();
  await importSample(page, 'sample.svg', SAMPLE_SVG);
  await expect(page.getByTestId('layer-row')).toHaveCount(2);

  // With a selection, the palette moves it to that layer.
  await page.getByTestId('palette-000000').click();
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
});

test('imports an SVG in millimetres', async ({ page }) => {
  await importSample(page, 'sample.svg', SAMPLE_SVG);
  await expect(page.getByTestId('shape-count')).toHaveText('1 shape');
  await expect(page.getByTestId('sel-w')).toHaveValue('40');
  await expect(page.getByTestId('sel-h')).toHaveValue('20');
});

test('rejects an unsupported file with a message', async ({ page }) => {
  await importSample(page, 'notes.txt', 'hello');
  await expect(page.getByTestId('notice')).toContainText('Unsupported file type');
  await expect(page.getByTestId('shape-count')).toHaveText('0 shapes');
});

test('moves, resizes, rotates and undoes via the panel and keyboard', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  const x = page.getByTestId('sel-x');
  const w = page.getByTestId('sel-w');
  const h = page.getByTestId('sel-h');

  await x.fill('200');
  await x.press('Enter');
  await expect(x).toHaveValue('200');

  await w.fill('50');
  await w.press('Enter');
  await expect(w).toHaveValue('50');
  await expect(h).toHaveValue('25'); // aspect locked

  await page.getByTestId('rotate-cw').click();
  await expect(w).toHaveValue('25');
  await expect(h).toHaveValue('50');

  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('ArrowRight');
  await expect(x).toHaveValue('213.5');

  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(w).toHaveValue('50');
  await page.keyboard.press('Control+y');
  await expect(w).toHaveValue('25');

  await x.fill('990');
  await x.press('Enter');
  await expect(page.getByTestId('out-of-bed')).toBeVisible();
});

test('selects and drags a shape with the mouse', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  const count = page.getByTestId('selection-count');
  const x = page.getByTestId('sel-x');

  // An imported file is one group; ungroup it so its shapes select one by one.
  await page.keyboard.press('Control+Shift+G');

  // Click empty bed to clear, then click the rectangle's top edge.
  const empty = await bedPoint(page, 600, 400);
  await page.mouse.click(empty.x, empty.y);
  await expect(count).toHaveText('0');

  const edge = await bedPoint(page, 30, 0);
  await page.mouse.click(edge.x, edge.y);
  await expect(count).toHaveText('1');
  await expect(page.getByTestId('sel-w')).toHaveValue('100');

  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.move(edge.x + 60, edge.y + 40, { steps: 5 });
  await page.mouse.up();
  const moved = Number(await x.inputValue());
  expect(moved).toBeCloseTo(60 / edge.scale, 0);

  // Marquee around everything selects both shapes.
  const a = await bedPoint(page, 900, 550);
  const b = await bedPoint(page, -5, -5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await expect(count).toHaveText('2');

  await page.keyboard.press('Delete');
  await expect(page.getByTestId('shape-count')).toHaveText('0 shapes');
  await expect(page.getByTestId('layer-row')).toHaveCount(0);
});

test('zooms with the wheel', async ({ page }) => {
  const centre = await bedPoint(page, 500, 300);
  await page.mouse.move(centre.x, centre.y);
  const before = await page.locator('.status-mono').nth(1).innerText();
  await page.mouse.wheel(0, -400);
  await expect(page.locator('.status-mono').nth(1)).not.toHaveText(before);
});

test('shows a job estimate, previews and exports an .rd file', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await expect(page.getByTestId('job-stats')).toBeVisible();
  // 300 mm rectangle + a 10 mm radius circle.
  await expect(page.getByTestId('job-cut')).toHaveText(/^36[23] mm$/);
  await expect(page.getByTestId('job-time')).toContainText('s');

  await page.getByTestId('preview-toggle').click();
  await expect(page.getByTestId('preview-slider')).toBeVisible();
  await page.getByTestId('preview-slider').fill('400');
  await page.getByTestId('preview-toggle').click();
  await expect(page.getByTestId('preview-slider')).toHaveCount(0);

  await page.getByTestId('job-name').fill('my test/part');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-rd').click()]);
  expect(download.suggestedFilename()).toBe('my_test_part.rd');
  const stream = await download.createReadStream();
  let size = 0;
  for await (const chunk of stream) size += (chunk as Buffer).length;
  expect(size).toBeGreaterThan(50);
  await expect(page.getByTestId('notice')).toContainText('Exported my_test_part.rd');
});

test('refuses to export a job that leaves the bed', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await expect(page.getByTestId('export-rd')).toBeEnabled();
  const x = page.getByTestId('sel-x');
  await x.fill('950');
  await x.press('Enter');
  await expect(page.getByTestId('job-problem')).toContainText('outside');
  await expect(page.getByTestId('export-rd')).toBeDisabled();
});

/** Opens the Nest tab and sets the quantity of the first listed part. */
async function openNestTab(page: Page, quantity: number) {
  await page.getByTestId('tab-nest').click();
  const qty = page.getByTestId('nest-qty').first();
  await qty.fill(String(quantity));
  await qty.press('Enter');
  await expect(qty).toHaveValue(String(quantity));
}

async function setSheet(page: Page, widthMm: number, heightMm: number) {
  const w = page.getByTestId('nest-sheet-w');
  await w.fill(String(widthMm));
  await w.press('Enter');
  const h = page.getByTestId('nest-sheet-h');
  await h.fill(String(heightMm));
  await h.press('Enter');
}

/** The first layout can take a while on a slow machine. */
const NEST_TIMEOUT = { timeout: 30_000 };

test('keeps the layers and job panels on the Cut tab', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await expect(page.getByTestId('tab-cut')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
  await page.getByTestId('tab-nest').click();
  await expect(page.getByTestId('layer-row')).toHaveCount(0);
  await expect(page.getByTestId('nest-start')).toBeVisible();
  await page.getByTestId('tab-cut').click();
  await expect(page.getByTestId('layer-row')).toHaveCount(1);
  await expect(page.getByTestId('export-rd')).toBeEnabled();
});

/** A 40 × 20 mm rectangle far away from the bed corner, so it is a part of its own. */
const SMALL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="600mm" viewBox="0 0 1000 600">' +
  '<rect x="500" y="300" width="40" height="20" stroke="#000000" fill="none"/></svg>';

/** Sixteen rectangles of different sizes: with rotation, far too many layouts to try them all. */
function manyPartsSvg(): string {
  const rects: string[] = [];
  for (let i = 0; i < 16; i++) {
    const x = 20 + (i % 4) * 240;
    const y = 20 + Math.floor(i / 4) * 140;
    rects.push(`<rect x="${x}" y="${y}" width="${30 + 6 * i}" height="${20 + 4 * i}" stroke="#000000" fill="none"/>`);
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="600mm" viewBox="0 0 1000 600">' +
    rects.join('') +
    '</svg>'
  );
}

const DONE = /^Done — best of [\d,]+ layouts?$/;

/** Layouts tried, read from the status line. */
async function layoutsTried(page: Page): Promise<number> {
  const text = await page.getByTestId('nest-status').innerText();
  const found = /([\d,]+) layouts?/.exec(text);
  if (!found?.[1]) throw new Error(`no layout count in "${text}"`);
  return Number(found[1].replace(/,/g, ''));
}

test('nests copies of a part straight into the document as one undo step', async ({ page }) => {
  await page.getByTestId('tab-nest').click();
  await expect(page.getByTestId('nest-start')).toBeDisabled();
  await expect(page.getByTestId('nest-status')).toHaveText('No parts to nest yet');

  await importSample(page, 'sample.dxf', sampleDxf());
  // The rectangle and the circle inside it are one part.
  await expect(page.getByTestId('nest-part')).toHaveCount(1);
  await expect(page.getByTestId('nest-part')).toContainText('100 × 50 mm');
  await expect(page.getByTestId('nest-source')).toContainText('selection');
  await expect(page.getByTestId('nest-result')).toHaveCount(0);
  await expect(page.getByTestId('nest-apply')).toHaveCount(0);
  await expect(page.getByTestId('nest-discard')).toHaveCount(0);

  await openNestTab(page, 3);
  await expect(page.getByTestId('nest-status')).toHaveText('Ready — 3 copies to nest');
  await expect(page.getByTestId('nest-start')).toHaveText('Nest');
  await page.getByTestId('nest-start').click();
  // The copies are in the document without any further step: 3 copies of 2 shapes.
  await expect(page.getByTestId('shape-count')).toHaveText('6 shapes', NEST_TIMEOUT);
  await expect(page.getByTestId('nest-utilization')).toHaveText(/^\d+\.\d %$/);
  await expect(page.getByTestId('nest-placed')).toHaveText('3 parts');
  await expect(page.getByTestId('nest-sheets')).toHaveText('1');
  await expect(page.getByTestId('nest-unplaced')).toHaveCount(0);
  await expect(page.getByTestId('nest-sheet-label')).toHaveCount(0);
  await expect(page.getByTestId('nest-sheet-note')).toHaveCount(0);
  await expect(page.getByTestId('selection-count')).toHaveText('0');
  await expect(page.getByTestId('out-of-bed')).toHaveCount(0);
  // The list still shows the part that was nested, not the copies.
  await expect(page.getByTestId('nest-part')).toHaveCount(1);
  await expect(page.getByTestId('nest-qty')).toHaveValue('3');
  await expect(page.getByTestId('nest-source')).toContainText('before nesting');

  // So few layouts are soon all tried.
  await expect(page.getByTestId('nest-status')).toHaveText(DONE, NEST_TIMEOUT);
  await expect(page.getByTestId('nest-stop')).toHaveCount(0);
  await expect(page.getByTestId('nest-start')).toHaveText('Nest again');
  await expect(page.getByTestId('nest-undo-hint')).toContainText('Ctrl+Z');
  await expect(page.getByTestId('notice')).toHaveText('Nested 3 parts on 1 sheet');

  // One undo puts the parts back as they were, selection and settings included.
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');
  await expect(page.getByTestId('nest-result')).toHaveCount(0);
  await expect(page.getByTestId('nest-start')).toHaveText('Nest');
  await expect(page.getByTestId('nest-status')).toHaveText('Ready — 3 copies to nest');
  await expect(page.getByTestId('nest-qty')).toHaveValue('3');
  await expect(page.getByTestId('selection-count')).toHaveText('2');
  await expect(page.getByTestId('nest-source')).toContainText('selection');

  // Redo brings the nest back without searching again.
  await page.keyboard.press('Control+y');
  await expect(page.getByTestId('shape-count')).toHaveText('6 shapes');
  await expect(page.getByTestId('nest-placed')).toHaveText('3 parts');
  await expect(page.getByTestId('nest-status')).toHaveText(DONE);
  await expect(page.getByTestId('nest-stop')).toHaveCount(0);
  await expect(page.getByTestId('nest-start')).toHaveText('Nest again');

  // The job on the Cut tab is the nested one: three rectangles and three circles.
  await page.getByTestId('tab-cut').click();
  await expect(page.getByTestId('job-cut')).toHaveText('1.09 m');
  await expect(page.getByTestId('export-rd')).toBeEnabled();

  // The step before the nest is the import: the nest was a single step.
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('shape-count')).toHaveText('0 shapes');
});

test('nests the whole document when nothing is selected', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Escape');
  await page.getByTestId('tab-nest').click();
  await expect(page.getByTestId('nest-source')).toContainText('whole document');
  await page.getByTestId('nest-start').click();
  await expect(page.getByTestId('nest-placed')).toHaveText('1 part', NEST_TIMEOUT);
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');
  // The part moved from the bed corner to the corner of the sheet margin.
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('selection-count')).toHaveText('2');
  await expect(page.getByTestId('sel-x')).toHaveValue('5');
  await expect(page.getByTestId('sel-y')).toHaveValue('5');
  // Selecting is not an edit: the result stays.
  await expect(page.getByTestId('nest-result')).toBeVisible();

  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('nest-result')).toHaveCount(0);
  await expect(page.getByTestId('nest-source')).toContainText('whole document');
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('sel-x')).toHaveValue('0');
  await expect(page.getByTestId('sel-y')).toHaveValue('0');
});

test('undo while the search is running stops it and puts the parts back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await importSample(page, 'many.svg', manyPartsSvg());
  await expect(page.getByTestId('shape-count')).toHaveText('16 shapes');
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Escape');
  await openNestTab(page, 3);
  await expect(page.getByTestId('nest-part')).toHaveCount(16);
  await expect(page.getByTestId('nest-status')).toHaveText('Ready — 18 copies to nest');
  await page.getByTestId('nest-start').click();

  // The first layout is in the document while the search goes on.
  await expect(page.getByTestId('shape-count')).toHaveText('18 shapes', NEST_TIMEOUT);
  await expect(page.getByTestId('nest-status')).toHaveText(/^Searching — \d+\.\d %, [\d,]+ layouts?$/);
  await expect(page.getByTestId('nest-start')).toHaveCount(0);
  await expect(page.getByTestId('nest-undo-hint')).toHaveCount(0);
  await expect(page.getByTestId('selection-count')).toHaveText('0');
  // Better layouts keep arriving and none of them adds or loses a shape.
  const before = await layoutsTried(page);
  await expect.poll(() => layoutsTried(page)).toBeGreaterThan(before);
  await expect(page.getByTestId('shape-count')).toHaveText('18 shapes');
  await expect(page.getByTestId('nest-stop')).toBeVisible();

  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('shape-count')).toHaveText('16 shapes');
  await expect(page.getByTestId('nest-stop')).toHaveCount(0);
  await expect(page.getByTestId('nest-result')).toHaveCount(0);
  await expect(page.getByTestId('nest-start')).toHaveText('Nest');
  await expect(page.getByTestId('nest-status')).toHaveText('Ready — 18 copies to nest');
  // The search is over: nothing puts a layout back.
  await page.waitForTimeout(700);
  await expect(page.getByTestId('shape-count')).toHaveText('16 shapes');
  await expect(page.getByTestId('nest-start')).toHaveText('Nest');

  // Redo brings the nest back as it was left, and the search does not start again.
  await page.keyboard.press('Control+y');
  await expect(page.getByTestId('shape-count')).toHaveText('18 shapes');
  await expect(page.getByTestId('nest-status')).toHaveText(/^Stopped — best of [\d,]+ layouts$/);
  await expect(page.getByTestId('nest-stop')).toHaveCount(0);
  await expect(page.getByTestId('nest-start')).toHaveText('Nest again');
  await expect(page.getByTestId('nest-placed')).toHaveText('18 parts');
  const stopped = await layoutsTried(page);
  await page.waitForTimeout(700);
  expect(await layoutsTried(page)).toBe(stopped);

  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('shape-count')).toHaveText('16 shapes');
  expect(errors).toEqual([]);
});

test('marks the nest out of date when a setting changes and nests the originals again', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await openNestTab(page, 2);
  await page.getByTestId('nest-start').click();
  await expect(page.getByTestId('shape-count')).toHaveText('4 shapes', NEST_TIMEOUT);
  const status = page.getByTestId('nest-status');
  await expect(status).toHaveText(DONE, NEST_TIMEOUT);

  // Nest again with nothing changed searches on; the layout stays unless a better one turns up.
  const first = await layoutsTried(page);
  await page.getByTestId('nest-start').click();
  await expect.poll(() => layoutsTried(page), NEST_TIMEOUT).toBeGreaterThan(first);
  await expect(status).toHaveText(DONE, NEST_TIMEOUT);
  await expect(page.getByTestId('shape-count')).toHaveText('4 shapes');
  await expect(page.getByTestId('nest-placed')).toHaveText('2 parts');

  // A new quantity: the nest in the document no longer matches the settings.
  const qty = page.getByTestId('nest-qty').first();
  await qty.fill('3');
  await qty.press('Enter');
  await expect(status).toHaveText('Out of date — settings changed');
  await expect(page.getByTestId('nest-start')).toHaveText('Nest again');
  await expect(page.getByTestId('nest-undo-hint')).toHaveCount(0);
  await expect(page.getByTestId('shape-count')).toHaveText('4 shapes');
  // Going back to the old value makes it current again.
  await qty.fill('2');
  await qty.press('Enter');
  await expect(status).toHaveText(DONE);
  await qty.fill('3');
  await qty.press('Enter');
  await expect(status).toContainText('Out of date');

  // Nest again takes the original part, not the two copies on the bed: 3 copies, not 6.
  await page.getByTestId('nest-start').click();
  await expect(page.getByTestId('shape-count')).toHaveText('6 shapes', NEST_TIMEOUT);
  await expect(page.getByTestId('nest-placed')).toHaveText('3 parts');
  await expect(status).toHaveText(DONE, NEST_TIMEOUT);
  await expect(page.getByTestId('nest-part')).toHaveCount(1);

  // The rotate flag and the options count as settings too.
  await page.getByTestId('nest-rotate').uncheck();
  await expect(status).toContainText('Out of date');
  await page.getByTestId('nest-rotate').check();
  await expect(status).toHaveText(DONE);
  await page.getByTestId('nest-rotation-step').selectOption('0');
  await expect(status).toContainText('Out of date');
  await page.getByTestId('nest-use-holes').uncheck();
  await page.getByTestId('nest-start').click();
  await expect(status).toHaveText(DONE, NEST_TIMEOUT);
  await expect(page.getByTestId('shape-count')).toHaveText('6 shapes');

  // However often it was nested again, one undo returns to the original part.
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');
  await expect(page.getByTestId('nest-start')).toHaveText('Nest');
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('sel-x')).toHaveValue('0');
  await expect(page.getByTestId('sel-w')).toHaveValue('100');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('shape-count')).toHaveText('0 shapes');
});

test('spreads parts over several sheets, swaps them on the bed and exports one .rd per sheet', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await importSample(page, 'small.svg', SMALL_SVG);
  await expect(page.getByTestId('shape-count')).toHaveText('3 shapes');
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Escape');
  // Two of the 100 × 50 part and one 40 × 20 part.
  await openNestTab(page, 2);
  await expect(page.getByTestId('nest-part')).toHaveCount(2);
  // Room for exactly one 100 × 50 part inside the 5 mm margin, and the small part does not fit beside it.
  await setSheet(page, 130, 80);
  await page.getByTestId('nest-start').click();

  const label = page.getByTestId('nest-sheet-label');
  const shapes = page.getByTestId('shape-count');
  await expect(label).toContainText('Sheet 1 of 3', NEST_TIMEOUT);
  await expect(page.getByTestId('nest-status')).toHaveText(DONE, NEST_TIMEOUT);
  await expect(label).toContainText('Sheet 1 of 3');
  await expect(label).toContainText('1 part');
  await expect(page.getByTestId('nest-sheets')).toHaveText('3');
  await expect(page.getByTestId('nest-placed')).toHaveText('3 parts');
  await expect(page.getByTestId('nest-sheet-note')).toContainText('export the sheets first');
  // Only the first sheet is on the bed: one copy of the large part. The best layout ends with the small part.
  await expect(shapes).toHaveText('2 shapes');
  await expect(page.getByTestId('nest-prev')).toBeDisabled();
  await page.getByTestId('nest-next').click();
  await expect(label).toContainText('Sheet 2 of 3');
  await expect(shapes).toHaveText('2 shapes');
  await page.getByTestId('nest-next').click();
  await expect(label).toContainText('Sheet 3 of 3');
  await expect(shapes).toHaveText('1 shape');
  await expect(page.getByTestId('nest-next')).toBeDisabled();
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('sel-x')).toHaveValue('5');
  await expect(page.getByTestId('sel-y')).toHaveValue('5');
  await page.keyboard.press('Escape');
  await page.getByTestId('nest-prev').click();
  await expect(label).toContainText('Sheet 2 of 3');
  await expect(shapes).toHaveText('2 shapes');
  await expect(page.getByTestId('out-of-bed')).toHaveCount(0);

  const names: string[] = [];
  const sizes: number[] = [];
  const saved: Promise<void>[] = [];
  page.on('download', (download) => {
    names.push(download.suggestedFilename());
    saved.push(
      (async () => {
        let size = 0;
        for await (const chunk of await download.createReadStream()) size += (chunk as Buffer).length;
        sizes.push(size);
      })(),
    );
  });
  await page.getByTestId('nest-export').click();
  await expect(page.getByTestId('notice')).toContainText('Exported 3 sheets');
  await expect.poll(() => names.length).toBe(3);
  await Promise.all(saved);
  expect([...names].sort()).toEqual(['job-sheet1.rd', 'job-sheet2.rd', 'job-sheet3.rd']);
  expect(sizes).toHaveLength(3);
  for (const size of sizes) expect(size).toBeGreaterThan(50);
  // Exporting leaves the bed and the result as they were.
  await expect(label).toContainText('Sheet 2 of 3');
  await expect(shapes).toHaveText('2 shapes');

  // After all that switching, one undo returns to the three original shapes.
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+z');
  await expect(shapes).toHaveText('3 shapes');
  await expect(label).toHaveCount(0);
  await expect(page.getByTestId('nest-sheet-note')).toHaveCount(0);
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('sel-w')).toHaveValue('540');
  // Redo shows the sheet that was on the bed.
  await page.keyboard.press('Control+y');
  await expect(label).toContainText('Sheet 2 of 3');
  await expect(shapes).toHaveText('2 shapes');
  // The step before the nest is the second import.
  await page.keyboard.press('Control+z');
  await expect(shapes).toHaveText('3 shapes');
  await page.keyboard.press('Control+z');
  await expect(shapes).toHaveText('2 shapes');
});

test('ends the nest when a nested part is moved by hand', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await openNestTab(page, 3);
  await setSheet(page, 130, 80);
  await page.getByTestId('nest-start').click();
  const label = page.getByTestId('nest-sheet-label');
  await expect(label).toContainText('Sheet 1 of 3', NEST_TIMEOUT);
  await expect(page.getByTestId('nest-status')).toHaveText(DONE, NEST_TIMEOUT);
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');
  await expect(page.getByTestId('nest-qty')).toHaveValue('3');

  // Drag the copy on the bed by its top edge, which sits on the sheet margin.
  const edge = await bedPoint(page, 50, 5);
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.move(edge.x + 60, edge.y + 40, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('selection-count')).toHaveText('2');
  expect(Math.abs(Number(await page.getByTestId('sel-x').inputValue()) - (5 + 60 / edge.scale))).toBeLessThan(1.5);

  // The layout is ordinary shapes now: no result, no other sheets, and the list shows what is in the document.
  await expect(label).toHaveCount(0);
  await expect(page.getByTestId('nest-sheet-note')).toHaveCount(0);
  await expect(page.getByTestId('nest-result')).toHaveCount(0);
  await expect(page.getByTestId('nest-export')).toHaveCount(0);
  await expect(page.getByTestId('nest-start')).toHaveText('Nest');
  await expect(page.getByTestId('nest-source')).toContainText('selection');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('nest-source')).toContainText('whole document');
  await expect(page.getByTestId('nest-part')).toHaveCount(1);
  // The copy on the bed is a new part with the default quantity, not the original with its 3.
  await expect(page.getByTestId('nest-qty')).toHaveValue('1');
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');

  // Undoing the move lands on the nest again, with its sheets; one more undo is the original part.
  await page.keyboard.press('Control+z');
  await expect(label).toContainText('Sheet 1 of 3');
  await expect(page.getByTestId('nest-qty')).toHaveValue('3');
  await page.keyboard.press('Control+z');
  await expect(label).toHaveCount(0);
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('sel-x')).toHaveValue('0');
});

test('warns about a part that fits no sheet and leaves it where it was', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await openNestTab(page, 1);
  await setSheet(page, 50, 40);
  await page.getByTestId('nest-start').click();
  await expect(page.getByTestId('nest-unplaced')).toContainText('1 part does not fit', NEST_TIMEOUT);
  await expect(page.getByTestId('nest-placed')).toHaveText('0 parts');
  await expect(page.getByTestId('nest-sheets')).toHaveText('0');
  await expect(page.getByTestId('nest-export')).toBeDisabled();
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');
  // Nothing was nested, so there is nothing to undo.
  await expect(page.getByTestId('nest-undo-hint')).toHaveCount(0);

  // With a second part that does fit, that one is nested and the large one stays put.
  await importSample(page, 'small.svg', SMALL_SVG);
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('nest-part')).toHaveCount(2);
  await page.getByTestId('nest-start').click();
  await expect(page.getByTestId('nest-placed')).toHaveText('1 part', NEST_TIMEOUT);
  await expect(page.getByTestId('nest-unplaced')).toContainText('1 part does not fit');
  await expect(page.getByTestId('nest-sheets')).toHaveText('1');
  await expect(page.getByTestId('shape-count')).toHaveText('3 shapes');
  // The small part went from x = 500 into the sheet; the large one still spans 0 to 100.
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('sel-x')).toHaveValue('0');
  await expect(page.getByTestId('sel-w')).toHaveValue('100');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('sel-w')).toHaveValue('540');
});

test('leaves a part with quantity 0 untouched', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await importSample(page, 'small.svg', SMALL_SVG);
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Escape');
  // None of the large part, two of the small one.
  await openNestTab(page, 0);
  const qty = page.getByTestId('nest-qty').nth(1);
  await qty.fill('2');
  await qty.press('Enter');
  await page.getByTestId('nest-start').click();
  await expect(page.getByTestId('nest-placed')).toHaveText('2 parts', NEST_TIMEOUT);
  // The large part's two shapes plus two copies of the small one.
  await expect(page.getByTestId('shape-count')).toHaveText('4 shapes');
  await expect(page.getByTestId('nest-part')).toHaveCount(2);
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+a');
  await expect(page.getByTestId('sel-x')).toHaveValue('0');
  await expect(page.getByTestId('sel-y')).toHaveValue('0');
  await expect(page.getByTestId('sel-w')).toHaveValue('100');
});

test('selects an imported file as one group', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await importSample(page, 'second.svg', SECOND_SVG);
  await expect(page.getByTestId('shape-count')).toHaveText('4 shapes');
  const count = page.getByTestId('selection-count');
  // The last import is the selection.
  await expect(count).toHaveText('2');
  await expect(page.getByTestId('sel-x')).toHaveValue('300');

  const empty = await bedPoint(page, 600, 400);
  await page.mouse.click(empty.x, empty.y);
  await expect(count).toHaveText('0');

  // One edge of the first file selects exactly that file's two shapes.
  const edge = await bedPoint(page, 30, 0);
  await page.mouse.click(edge.x, edge.y);
  await expect(count).toHaveText('2');
  await expect(page.getByTestId('sel-x')).toHaveValue('0');
  await expect(page.getByTestId('sel-w')).toHaveValue('100');

  // The inner rectangle of the second file brings its outline along.
  const inner = await bedPoint(page, 350, 230);
  await page.mouse.click(inner.x, inner.y);
  await expect(count).toHaveText('2');
  await expect(page.getByTestId('sel-x')).toHaveValue('300');
  await expect(page.getByTestId('sel-w')).toHaveValue('120');

  // Shift-click adds the other file as a whole; Select all takes everything.
  await page.keyboard.down('Shift');
  await page.mouse.click(edge.x, edge.y);
  await page.keyboard.up('Shift');
  await expect(count).toHaveText('4');
  await page.mouse.click(empty.x, empty.y);
  await page.keyboard.press('Control+a');
  await expect(count).toHaveText('4');

  // A marquee that encloses only part of a file selects nothing of it.
  await page.mouse.click(empty.x, empty.y);
  const a = await bedPoint(page, 320, 215);
  const b = await bedPoint(page, 400, 265);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await expect(count).toHaveText('0');
  // Dragged right-to-left it touches the file, which selects all of it.
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y, { steps: 5 });
  await page.mouse.up();
  await expect(count).toHaveText('2');
});

test('ungroups and groups with the keyboard, one undo step each', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  const count = page.getByTestId('selection-count');
  const empty = await bedPoint(page, 600, 400);
  const edge = await bedPoint(page, 30, 0);
  const circle = await bedPoint(page, 60, 25);
  const clickEdge = async () => {
    await page.mouse.click(empty.x, empty.y);
    await expect(count).toHaveText('0');
    await page.mouse.click(edge.x, edge.y);
  };

  // One group is selected: it can be ungrouped but not grouped again.
  await expect(page.getByTestId('group')).toBeDisabled();
  await expect(page.getByTestId('ungroup')).toBeEnabled();
  await page.keyboard.press('Control+Shift+G');
  // The selection stays on the same shapes.
  await expect(count).toHaveText('2');
  await expect(page.getByTestId('ungroup')).toBeDisabled();
  await expect(page.getByTestId('group')).toBeEnabled();
  await clickEdge();
  await expect(count).toHaveText('1');

  // Shift-click the circle too and group the two again.
  await page.keyboard.down('Shift');
  await page.mouse.click(circle.x, circle.y);
  await page.keyboard.up('Shift');
  await expect(count).toHaveText('2');
  await page.keyboard.press('Control+g');
  await expect(count).toHaveText('2');
  await clickEdge();
  await expect(count).toHaveText('2');

  // One undo takes the group apart again, the next one restores the imported group.
  await page.keyboard.press('Control+z');
  await clickEdge();
  await expect(count).toHaveText('1');
  await page.keyboard.press('Control+z');
  await clickEdge();
  await expect(count).toHaveText('2');
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');
  // And the one after that is the import itself.
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('shape-count')).toHaveText('0 shapes');

  // The toolbar buttons do the same.
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+a');
  await page.getByTestId('ungroup').click();
  await clickEdge();
  await expect(count).toHaveText('1');
  await page.keyboard.press('Control+a');
  await page.getByTestId('group').click();
  await clickEdge();
  await expect(count).toHaveText('2');
});

test('enters a group with a double-click and leaves it with Escape', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await importSample(page, 'second.svg', SECOND_SVG);
  const count = page.getByTestId('selection-count');
  const hint = page.getByTestId('group-scope');
  const edge = await bedPoint(page, 30, 0);
  const circle = await bedPoint(page, 60, 25);
  const other = await bedPoint(page, 330, 200);
  const empty = await bedPoint(page, 600, 400);
  await expect(hint).toHaveCount(0);

  await page.mouse.dblclick(edge.x, edge.y);
  await expect(hint).toContainText('Esc to leave');
  await expect(count).toHaveText('1');
  await expect(page.getByTestId('sel-w')).toHaveValue('100');

  // Inside the group its shapes select one by one, and Select all stays inside.
  await page.mouse.click(circle.x, circle.y);
  await expect(count).toHaveText('1');
  await expect(page.getByTestId('sel-w')).toHaveValue('20');
  await expect(hint).toBeVisible();
  await page.keyboard.press('Control+a');
  await expect(count).toHaveText('2');

  // Escape leaves and selects the group that was left.
  await page.mouse.click(circle.x, circle.y);
  await page.keyboard.press('Escape');
  await expect(hint).toHaveCount(0);
  await expect(count).toHaveText('2');
  await expect(page.getByTestId('sel-w')).toHaveValue('100');
  // At top level Escape still clears the selection.
  await page.keyboard.press('Escape');
  await expect(count).toHaveText('0');

  // Clicking a shape outside the entered group leaves it and selects that shape's group.
  await page.mouse.dblclick(edge.x, edge.y);
  await expect(hint).toBeVisible();
  await page.mouse.click(other.x, other.y);
  await expect(hint).toHaveCount(0);
  await expect(count).toHaveText('2');
  await expect(page.getByTestId('sel-x')).toHaveValue('300');

  // Clicking empty space leaves as well.
  await page.mouse.dblclick(edge.x, edge.y);
  await expect(hint).toBeVisible();
  await page.mouse.click(empty.x, empty.y);
  await expect(hint).toHaveCount(0);
  await expect(count).toHaveText('0');

  // Undoing the import of the entered group drops back to top level.
  await page.mouse.dblclick(other.x, other.y);
  await expect(hint).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');
  await expect(hint).toHaveCount(0);
});

test('copies and pastes a group at the mouse and next to the original', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  const count = page.getByTestId('selection-count');
  const shapes = page.getByTestId('shape-count');
  const x = page.getByTestId('sel-x');
  const y = page.getByTestId('sel-y');
  await expect(page.getByTestId('paste')).toBeDisabled();

  const target = await bedPoint(page, 500, 300);
  await page.mouse.move(target.x, target.y);
  await page.keyboard.press('Control+c');
  await expect(page.getByTestId('paste')).toBeEnabled();
  await expect(shapes).toHaveText('2 shapes');
  await page.keyboard.press('Control+v');
  await expect(shapes).toHaveText('4 shapes');
  // The paste is the selection, centred on the mouse.
  await expect(count).toHaveText('2');
  await expect(page.getByTestId('sel-w')).toHaveValue('100');
  expect(Math.abs(Number(await x.inputValue()) - 450)).toBeLessThan(1.5);
  expect(Math.abs(Number(await y.inputValue()) - 275)).toBeLessThan(1.5);

  // The copy is a group of its own: one click on its edge selects it, and it moves as one.
  const empty = await bedPoint(page, 800, 500);
  await page.mouse.click(empty.x, empty.y);
  await expect(count).toHaveText('0');
  const edge = await bedPoint(page, 451, 300);
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.move(edge.x + 50, edge.y + 30, { steps: 5 });
  await page.mouse.up();
  await expect(count).toHaveText('2');
  await expect(page.getByTestId('sel-w')).toHaveValue('100');
  expect(Math.abs(Number(await x.inputValue()) - (450 + 50 / edge.scale))).toBeLessThan(1.5);

  // One undo for the move, one for the paste.
  await page.keyboard.press('Control+z');
  await expect(shapes).toHaveText('4 shapes');
  await page.keyboard.press('Control+z');
  await expect(shapes).toHaveText('2 shapes');

  // The toolbar pastes a step away from the original, and a step further each time.
  await page.getByTestId('paste').click();
  await expect(shapes).toHaveText('4 shapes');
  await expect(count).toHaveText('2');
  await expect(x).toHaveValue('10');
  await expect(y).toHaveValue('10');
  await page.getByTestId('paste').click();
  await expect(shapes).toHaveText('6 shapes');
  await expect(x).toHaveValue('20');
  await expect(y).toHaveValue('20');
  // The original is still a group of two.
  await page.mouse.click(empty.x, empty.y);
  const original = await bedPoint(page, 5, 0);
  await page.mouse.click(original.x, original.y);
  await expect(count).toHaveText('2');
  await expect(x).toHaveValue('0');
});

test('duplicates with Ctrl+D and cuts with Ctrl+X', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  const count = page.getByTestId('selection-count');
  const shapes = page.getByTestId('shape-count');
  const x = page.getByTestId('sel-x');

  await page.keyboard.press('Control+d');
  await expect(shapes).toHaveText('4 shapes');
  await expect(count).toHaveText('2');
  await expect(x).toHaveValue('10');
  await expect(page.getByTestId('sel-y')).toHaveValue('10');
  // Duplicating leaves the clipboard alone.
  await expect(page.getByTestId('paste')).toBeDisabled();
  await page.keyboard.press('Control+z');
  await expect(shapes).toHaveText('2 shapes');

  await page.keyboard.press('Control+a');
  await expect(count).toHaveText('2');
  await page.keyboard.press('Control+x');
  await expect(shapes).toHaveText('0 shapes');
  await expect(page.getByTestId('paste')).toBeEnabled();
  // The mouse is not over the canvas, so the paste lands a step from where the shapes were.
  await page.keyboard.press('Control+v');
  await expect(shapes).toHaveText('2 shapes');
  await expect(count).toHaveText('2');
  await expect(x).toHaveValue('10');

  // One undo for the paste, one for the cut.
  await page.keyboard.press('Control+z');
  await expect(shapes).toHaveText('0 shapes');
  await page.keyboard.press('Control+z');
  await expect(shapes).toHaveText('2 shapes');
  await page.keyboard.press('Control+z');
  await expect(shapes).toHaveText('0 shapes');
});

test('leaves copy, paste and typing alone inside a number field', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  const shapes = page.getByTestId('shape-count');
  const x = page.getByTestId('sel-x');
  const y = page.getByTestId('sel-y');

  // Copying text in a field does not copy the shapes.
  await x.fill('123');
  await x.press('Control+a');
  await x.press('Control+c');
  await expect(page.getByTestId('paste')).toBeDisabled();
  // And the text really went to the clipboard: paste it into another field.
  await y.focus();
  await y.press('Control+a');
  await y.press('Control+v');
  await expect(y).toHaveValue('123');
  await y.press('Escape');

  // With shapes on the internal clipboard, the shortcuts still belong to the field.
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+c');
  await expect(page.getByTestId('paste')).toBeEnabled();
  await x.focus();
  await x.press('Control+v');
  await x.press('Control+d');
  await x.press('Control+x');
  await x.press('Control+g');
  await x.press('Escape');
  await expect(shapes).toHaveText('2 shapes');
  await expect(page.getByTestId('selection-count')).toHaveText('2');
});

test('keeps the editing shortcuts inert while a preview is on show', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  const shapes = page.getByTestId('shape-count');
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+c');

  await page.getByTestId('preview-toggle').click();
  await expect(page.getByTestId('preview-slider')).toBeVisible();
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+d');
  await page.keyboard.press('Control+v');
  await page.keyboard.press('Control+x');
  await page.keyboard.press('Control+Shift+G');
  const edge = await bedPoint(page, 30, 0);
  await page.mouse.dblclick(edge.x, edge.y);
  await expect(page.getByTestId('group-scope')).toHaveCount(0);
  await expect(shapes).toHaveText('2 shapes');
  await page.getByTestId('preview-toggle').click();

  // The import group is still whole.
  const empty = await bedPoint(page, 600, 400);
  await page.mouse.click(empty.x, empty.y);
  await page.mouse.click(edge.x, edge.y);
  await expect(page.getByTestId('selection-count')).toHaveText('2');
});

test('keeps the canvas editable after nesting: a copy with a hole selects as one group', async ({ page }) => {
  await importSample(page, 'sample.dxf', sampleDxf());
  await openNestTab(page, 2);
  await page.getByTestId('nest-start').click();
  await expect(page.getByTestId('nest-placed')).toHaveText('2 parts', NEST_TIMEOUT);
  await expect(page.getByTestId('shape-count')).toHaveText('4 shapes');
  await expect(page.getByTestId('nest-status')).toHaveText(DONE, NEST_TIMEOUT);
  const count = page.getByTestId('selection-count');
  // Nothing is selected when the search has ended.
  await expect(count).toHaveText('0');

  // The copy in the top-left corner of the layout: its left edge starts at the layout's corner.
  await page.getByTestId('workspace-canvas').focus();
  await page.keyboard.press('Control+a');
  await expect(count).toHaveText('4');
  const left = Number(await page.getByTestId('sel-x').inputValue());
  const top = Number(await page.getByTestId('sel-y').inputValue());
  const empty = await bedPoint(page, 800, 500);
  await page.mouse.click(empty.x, empty.y);
  await expect(count).toHaveText('0');
  const edge = await bedPoint(page, left, top + 25);
  await page.mouse.click(edge.x, edge.y);
  // Outline and hole together, but not the other copy.
  await expect(count).toHaveText('2');
  // A double-click goes into the copy's group, as with any group.
  await page.mouse.dblclick(edge.x, edge.y);
  await expect(page.getByTestId('group-scope')).toContainText('Esc to leave');
  await expect(count).toHaveText('1');
  await page.keyboard.press('Escape');
  await expect(count).toHaveText('2');
  // Selecting changed nothing, so the result is still on show.
  await expect(page.getByTestId('nest-result')).toBeVisible();

  // The editing keys work: deleting the copy is an edit like any other, and it ends the nest.
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('shape-count')).toHaveText('2 shapes');
  await expect(page.getByTestId('nest-result')).toHaveCount(0);
  await expect(page.getByTestId('nest-start')).toHaveText('Nest');
});
