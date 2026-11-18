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
 * Electron's menu template from tray-menu.js's items: submenus as submenus, and what an item carries for its click
 * (a script's step, a scene) kept out of the template and handed back with it.
 * @param {object[]} items
 * @param {(id:string, checked?:boolean, item?:object) => void} onAction
 */
export function menuTemplate(items, onAction) {
  return items.map((item) => {
    if (item.type === 'separator') return { type: 'separator' };
    const { step, scene, submenu, ...rest } = item;
    if (submenu) return { ...rest, submenu: menuTemplate(submenu, onAction) };
    return { ...rest, click: (menuItem) => onAction(item.id, menuItem.checked, item) };
  });
}

/**
 * @param {(id:string, checked?:boolean, item?:object) => void} onAction  a menu item was chosen
 */
export function createTray(onAction) {
  const tray = new Tray(trayIcon());
  let current = null;
  return {
    /** @param {{tooltip:string, title:string, items:object[]}} model  from tray-menu.js */
    update(model) {
      const key = JSON.stringify(model);
      if (key === current) return;
      current = key;
      tray.setToolTip(model.tooltip);
      if (process.platform === 'darwin') tray.setTitle(model.title);
      tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(model.items, onAction)));
    },
    destroy() {
      tray.destroy();
    }
  };
}
