/**
 * The menu-bar (macOS) or notification-area (Windows) icon, Jester's only
 * permanent presence: there is no window until you open Settings.
 */

import { Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { ROOTS } from './files.js';

function trayIcon() {
  const icons = path.join(ROOTS.ext, 'icons');
  const image = nativeImage.createFromPath(path.join(icons, 'icon16.png'));
  image.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(path.join(icons, 'icon32.png')).toPNG() });
  return image;
}

/**
 * @param {(id:string, checked?:boolean) => void} onAction  a menu item was chosen
 */
export function createTray(onAction) {
  const tray = new Tray(trayIcon());
  let current = null;
  return {
    /** @param {{tooltip:string, items:object[]}} model  from tray-menu.js */
    update(model) {
      const key = JSON.stringify(model);
      if (key === current) return;
      current = key;
      tray.setToolTip(model.tooltip);
      tray.setContextMenu(
        Menu.buildFromTemplate(
          model.items.map((item) =>
            item.type === 'separator'
              ? { type: 'separator' }
              : { ...item, click: (menuItem) => onAction(item.id, menuItem.checked) }
          )
        )
      );
    },
    destroy() {
      tray.destroy();
    }
  };
}
