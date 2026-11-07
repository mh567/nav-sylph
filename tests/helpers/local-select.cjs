'use strict';

module.exports = async function localSelect(page, id, value) {
    const index = typeof value === 'number' ? value : await page.locator(`#${id}`).evaluate((select, value) =>
        [...select.options].findIndex(option => option.value === value), value);
    if (index < 0) throw new Error(`Missing ${id} option: ${value}`);
    await page.locator(`#${id}Button`).click();
    await page.locator(`#${id}Option${index}`).click();
};
