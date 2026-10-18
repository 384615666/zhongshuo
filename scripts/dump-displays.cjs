/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { app, screen } = require('electron');

app.whenReady().then(() => {
  const primary = screen.getPrimaryDisplay();
  process.stdout.write(`${JSON.stringify({
    primaryId: primary.id,
    displays: screen.getAllDisplays().map((display) => ({
      id: display.id,
      label: display.label,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
    })),
  }, null, 2)}\n`);
  app.quit();
});
