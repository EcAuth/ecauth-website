import { expect, test } from '@playwright/test';

/**
 * 特定商取引法に基づく表記と、フッターの規約・法定表記リンク。
 * Stripe のアカウント有効化と Customer Portal のビジネス情報がこの URL を参照するため、
 * パス（/tradelaw/）を変えたらダッシュボード側も直す。
 */
test.describe('特定商取引法に基づく表記', () => {
  test('/tradelaw/ に事業者情報と支払い条件が載っている', async ({ page }) => {
    await page.goto('/tradelaw/');

    await expect(page).toHaveTitle('特定商取引法に基づく表記 — EcAuth');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('特定商取引法に基づく表記');
    for (const label of ['販売事業者', '所在地', '電話番号', 'メールアドレス', '販売価格', 'お支払い方法', 'お支払い時期', '返品・キャンセル']) {
      await expect(page.getByRole('cell', { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByText('support@ec-auth.io')).toBeVisible();
  });

  test('フッターから利用規約・プライバシーポリシー・特商法表記へ遷移できる', async ({ page }) => {
    await page.goto('/');

    const legal = page.getByRole('navigation', { name: '規約・法定表記' });
    await expect(legal.getByRole('link', { name: '利用規約' })).toHaveAttribute('href', /terms-of-service\.md$/);
    await expect(legal.getByRole('link', { name: 'プライバシーポリシー' })).toHaveAttribute('href', /privacy-policy\.md$/);

    await legal.getByRole('link', { name: '特定商取引法に基づく表記' }).click();
    await expect(page).toHaveURL(/\/tradelaw\/$/);
  });
});
