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
