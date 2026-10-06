// Bops: the page a bot is working on is the one on its screen, so the user sees it. Loaded by the
// browser tools (Playwright MCP --init-page) for every page they track: each time the bot
// navigates a page, that tab comes to the front of its screen's Chrome.
module.exports.default = async ({ page }) => {
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) page.bringToFront().catch(() => {});
  });
};
