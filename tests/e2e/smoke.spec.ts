import { expect, test } from '@playwright/test';

test('app loads and shows the bed size', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'LaserAlfredo' })).toBeVisible();
  await expect(page.getByTestId('bed-size')).toHaveText('Bed 1000 × 600 mm');
});
