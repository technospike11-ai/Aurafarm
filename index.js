const http = require('http');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalBlock, GoalInvert, GoalFollow } = goals;
const fs = require('fs');
const { Vec3 } = require('vec3');

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('LootMaster Bot is Alive!');
}).listen(process.env.PORT || 3000, () => {
  console.log('Keep-alive server running...');
});

const CONFIG = {
  host: 'bluemc.org',
  port: 25565,
  version: '1.21.4',
  username: 'SpicyLoot_99',
  auth: 'offline',
  password: 'Shivam',
  owners: ['Spicy_GamerzZ', 'mukesh_pvp_399'],
  safeZone: { x: 0, y: 65, z: 0 },
  enderChestPos: { x: 2, y: 65, z: 2 },
  dodgeDistance: 2
};

function isOwner(name) {
  return CONFIG.owners.includes(name);
}

const ZONES_FILE = './zones.json';
const COMBAT_DURATION_MS = 22500;

function loadZones() {
  if (fs.existsSync(ZONES_FILE)) {
    try {
      const d = JSON.parse(fs.readFileSync(ZONES_FILE, 'utf8'));
      return {
        safeZone: d.safeZone || CONFIG.safeZone,
        unsafeZone: d.unsafeZone || { x: 0, y: 65, z: 25 },
        enderChestPos: d.enderChestPos || CONFIG.enderChestPos
      };
    } catch {}
  }
  return {
    safeZone: CONFIG.safeZone,
    unsafeZone: { x: 0, y: 65, z: 25 },
    enderChestPos: CONFIG.enderChestPos
  };
}

function saveZones() {
  fs.writeFileSync(ZONES_FILE, JSON.stringify(zones, null, 2));
}

let zones = loadZones();

const bot = mineflayer.createBot({
  host: CONFIG.host,
  port: CONFIG.port,
  version: CONFIG.version,
  username: CONFIG.username,
  auth: CONFIG.auth
});

bot.loadPlugin(pathfinder);

let mode = 'auto';
let offlineMode = true;
let isBusy = false;
let isDodging = false;
let isMiningCube = false;
let stopRequested = false;
let inCombat = false;
let combatEndTime = 0;
let strafeInterval = null;
let farmInterval = null;
let cleaningTrash = false;
let invListenerAttached = false;
let activeOwner = CONFIG.owners[0];

function sendForceAuth() {
  setTimeout(() => {
    try {
      bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`);
      console.log('Force sent: /register');
    } catch {}
  }, 1500);

  setTimeout(() => {
    try {
      bot.chat(`/login ${CONFIG.password}`);
      console.log('Force sent: /login');
    } catch {}
  }, 3500);
}

bot.on('login', () => {
  console.log('Server login packet received! Force auth start...');
  sendForceAuth();
});

bot.on('messagestr', (message) => {
  console.log('[CHAT]', message);
});

function triggerCombatState() {
  inCombat = true;
  isMiningCube = false;
  bot.pathfinder.setGoal(null);
  if (!strafeInterval) {
    let dir = 'left';
    strafeInterval = setInterval(() => {
      if (Date.now() >= combatEndTime) return stopCombatStrafe();
      const attacker = bot.nearestEntity(
        (e) => e.type === 'player' && e.username !== bot.username && !isOwner(e.username)
      );
      if (attacker) {
        const dx = bot.entity.position.x - attacker.position.x;
        const dz = bot.entity.position.z - attacker.position.z;
        bot.look(Math.atan2(-dx, -dz), 0, true);
      }
      bot.setControlState('sprint', true);
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      bot.setControlState('left', dir === 'left');
      bot.setControlState('right', dir === 'right');
      dir = dir === 'left' ? 'right' : 'left';
    }, 550);
  }
}

function stopCombatStrafe() {
  inCombat = false;
  if (strafeInterval) {
    clearInterval(strafeInterval);
    strafeInterval = null;
  }
  bot.clearControlStates();
  goToSafeZone(() => {
    if (hasValuableLoot() && (mode === 'auto' || offlineMode)) {
      storeInEnderChest(false, activeOwner);
    } else {
      bot.chat(`/msg ${activeOwner} Combat timer khatam, safe zone aa gaya!`);
    }
  });
}

bot.on('actionBar', (jsonMsg) => {
  const actionText = jsonMsg.toString().toLowerCase();
  if (actionText.includes('combat')) {
    const timeMatch = actionText.match(/(\d+(\.\d+)?)\s*s/);
    combatEndTime = timeMatch
      ? Date.now() + parseFloat(timeMatch[1]) * 1000 + 500
      : Date.now() + COMBAT_DURATION_MS;
    if (!inCombat) triggerCombatState();
  }
});

bot.on('entityHurt', (entity) => {
  if (entity === bot.entity) {
    combatEndTime = Date.now() + COMBAT_DURATION_MS;
    if (!inCombat) triggerCombatState();
  }
});

bot.on('death', () => {
  isBusy = false;
  isMiningCube = false;
  inCombat = false;
  if (strafeInterval) {
    clearInterval(strafeInterval);
    strafeInterval = null;
  }
  bot.clearControlStates();
  setTimeout(() => bot.respawn(), 1000);
});

bot.on('spawn', () => {
  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  defaultMove.canDig = false;
  bot.pathfinder.setMovements(defaultMove);
  isBusy = false;

  if (!fs.existsSync(ZONES_FILE)) {
    const p = bot.entity.position.floored();
    zones.safeZone = { x: p.x, y: p.y, z: p.z };
    zones.unsafeZone = { x: p.x, y: p.y, z: p.z };
    saveZones();
  }

  if (!invListenerAttached && bot.inventory) {
    invListenerAttached = true;
    bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
      if (newItem && getItemTier(newItem.name) === 0) {
        setTimeout(() => purgeJunkItems(), 150);
      }
    });
  }

  console.log('Bot bluemc.org par spawn aur ready hai (Auto-Roam ON)!');
});
function getItemTier(itemName) {
  if (!itemName) return 0;
  const name = itemName.toLowerCase();
  const tier2Items = [
    'netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots',
    'netherite_sword', 'netherite_axe', 'netherite_spear', 'netherite_pickaxe',
    'netherite_shovel', 'netherite_ingot', 'netherite_scrap', 'netherite_upgrade_smithing_template'
  ];
  if (tier2Items.includes(name)) return 2;

  const tier1Items = [
    'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
    'diamond_sword', 'diamond_axe', 'diamond_spear', 'diamond_pickaxe',
    'diamond_shovel', 'diamond', 'totem_of_undying', 'enchanted_golden_apple', 'golden_apple'
  ];
  if (tier1Items.includes(name)) return 1;
  return 0;
}

function hasValuableLoot() {
  return bot.inventory.items().some((item) => getItemTier(item.name) > 0);
}

async function purgeJunkItems() {
  if (cleaningTrash || isMiningCube) return;
  const junkItems = bot.inventory.items().filter((item) => getItemTier(item.name) === 0);
  if (junkItems.length === 0) return;
  cleaningTrash = true;
  for (const junk of junkItems) {
    try { await bot.tossStack(junk); } catch {}
  }
  cleaningTrash = false;
}

function goToSafeZone(callback) {
  isBusy = true;
  const { x, y, z } = zones.safeZone;
  bot.pathfinder.setGoal(new GoalBlock(x, y, z));
  bot.once('goal_reached', () => {
    setTimeout(() => {
      isBusy = false;
      if (callback) callback();
    }, 5000);
  });
}

async function storeInEnderChest(sendTag = false, replyTo = activeOwner) {
  isBusy = true;
  const { x, y, z } = zones.enderChestPos;
  bot.pathfinder.setGoal(new GoalNear(x, y, z, 2));
  bot.once('goal_reached', async () => {
    try {
      const ecBlock = bot.blockAt(new Vec3(x, y, z));
      if (!ecBlock || !ecBlock.name.includes('ender_chest')) {
        bot.chat(`/msg ${replyTo} Ender Chest nahi mila! EC ke paas khade hokar !setec likho.`);
        isBusy = false;
        return;
      }
      await bot.lookAt(ecBlock.position.offset(0.5, 0.5, 0.5));
      const chest = await bot.openContainer(ecBlock);
      const myItems = bot.inventory.items().filter((i) => getItemTier(i.name) > 0);
      for (const item of myItems) {
        try {
          await chest.deposit(item.type, null, item.count);
        } catch {
          if (getItemTier(item.name) === 2) {
            const d = chest.containerItems().find((c) => getItemTier(c.name) === 1);
            if (d) {
              await chest.withdraw(d.type, null, d.count);
              await bot.tossStack(d);
              await chest.deposit(item.type, null, item.count);
            }
          }
        }
      }
      chest.close();
      bot.chat(sendTag ? `/msg ${replyTo} [enderchest]` : `/msg ${replyTo} Loot Ender Chest mein safe rakh diya!`);
    } catch (e) {
      console.log('EC Error:', e);
    }
    isBusy = false;
  });
}

async function openEnderChestOnly(replyTo = activeOwner) {
  isBusy = true;
  const { x, y, z } = zones.enderChestPos;
  bot.pathfinder.setGoal(new GoalNear(x, y, z, 2));
  bot.once('goal_reached', async () => {
    try {
      const ecBlock = bot.blockAt(new Vec3(x, y, z));
      if (!ecBlock || !ecBlock.name.includes('ender_chest')) {
        bot.chat(`/msg ${replyTo} Ender Chest nahi mila! Pehle !setec likho.`);
        isBusy = false;
        return;
      }
      await bot.lookAt(ecBlock.position.offset(0.5, 0.5, 0.5));
      const chest = await bot.openContainer(ecBlock);
      bot.chat(`/msg ${replyTo} Ender Chest khol liya! (${chest.containerItems().length} stacks)`);
      setTimeout(() => { try { chest.close(); } catch {} isBusy = false; }, 2000);
    } catch { isBusy = false; }
  });
}

async function withdrawAllAndDrop(replyTo = activeOwner) {
  isBusy = true;
  const { x, y, z } = zones.enderChestPos;
  bot.pathfinder.setGoal(new GoalNear(x, y, z, 2));
  bot.once('goal_reached', async () => {
    try {
      const ecBlock = bot.blockAt(new Vec3(x, y, z));
      await bot.lookAt(ecBlock.position.offset(0.5, 0.5, 0.5));
      const chest = await bot.openContainer(ecBlock);
      for (const item of chest.containerItems()) {
        await chest.withdraw(item.type, null, item.count);
      }
      chest.close();
      await dropAllItems(replyTo);
    } catch {}
    isBusy = false;
  });
}

async function dropAllItems(replyTo = activeOwner) {
  const items = bot.inventory.items();
  if (!items.length) return bot.chat(`/msg ${replyTo} Inventory khali hai.`);
  for (const item of items) await bot.tossStack(item);
  bot.chat(`/msg ${replyTo} Saara saaman drop kar diya!`);
}

async function getItemFromEC(itemName, count, replyTo = activeOwner) {
  isBusy = true;
  const { x, y, z } = zones.enderChestPos;
  bot.pathfinder.setGoal(new GoalNear(x, y, z, 2));
  bot.once('goal_reached', async () => {
    try {
      const ecBlock = bot.blockAt(new Vec3(x, y, z));
      await bot.lookAt(ecBlock.position.offset(0.5, 0.5, 0.5));
      const chest = await bot.openContainer(ecBlock);
      const target = chest.containerItems().find((i) => i.name.toLowerCase().includes(itemName.toLowerCase()));
      if (!target) {
        bot.chat(`/msg ${replyTo} Ender Chest mein "${itemName}" nahi mila.`);
      } else {
        const amount = count ? Math.min(count, target.count) : target.count;
        await chest.withdraw(target.type, null, amount);
        bot.chat(`/msg ${replyTo} EC se ${target.name} x${amount} nikal liya!`);
      }
      chest.close();
    } catch {}
    isBusy = false;
  });
                                      }
    function runCommandAndClickGUI(serverCommand, targetItemKeyword, index = 1, replyTo = activeOwner) {
  return new Promise((resolve) => {
    let handled = false;
    const onWindowOpen = async (window) => {
      if (handled) return;
      handled = true;
      bot.removeListener('windowOpen', onWindowOpen);
      setTimeout(async () => {
        try {
          const matching = window.slots.filter((i) => i && i.name.toLowerCase().includes(targetItemKeyword.toLowerCase()));
          const chosen = matching[index - 1];
          if (chosen) {
            await bot.clickWindow(chosen.slot, 0, 0);
            bot.chat(`/msg ${replyTo} ${serverCommand} -> ${chosen.name} par click kar diya!`);
          }
        } catch {}
        resolve();
      }, 600);
    };
    bot.once('windowOpen', onWindowOpen);
    bot.chat(serverCommand);
    setTimeout(() => { if (!handled) { handled = true; bot.removeListener('windowOpen', onWindowOpen); resolve(); } }, 4000);
  });
}

async function equipBestArmor() {
  const types = [{ s: 'helmet', slot: 'head' }, { s: 'chestplate', slot: 'torso' }, { s: 'leggings', slot: 'legs' }, { s: 'boots', slot: 'feet' }];
  const score = (n) => n.includes('netherite') ? 4 : n.includes('diamond') ? 3 : n.includes('iron') ? 2 : 1;
  for (const a of types) {
    const pieces = bot.inventory.items().filter((i) => i.name.endsWith(a.s)).sort((x, y) => score(y.name) - score(x.name));
    if (pieces.length) { try { await bot.equip(pieces[0], a.slot); } catch {} }
  }
}

async function equipBestWeapon() {
  const weapons = bot.inventory.items().filter((i) => i.name.includes('sword') || i.name.includes('_axe') || i.name.includes('spear'));
  if (weapons.length) {
    const score = (n) => n.includes('netherite') ? 4 : n.includes('diamond') ? 3 : n.includes('iron') ? 2 : 1;
    weapons.sort((a, b) => score(b.name) - score(a.name));
    try { await bot.equip(weapons[0], 'hand'); } catch {}
  }
}

async function breakCubeArea(l, h, w, replyTo = activeOwner) {
  if (isMiningCube) return bot.chat(`/msg ${replyTo} Pehle se mining chal rahi hai! !stop likho.`);
  isMiningCube = true;
  isBusy = true;
  stopRequested = false;
  const startPos = bot.entity.position.floored();
  bot.chat(`/msg ${replyTo} ${l}x${h}x${w} cube break shuru!`);
  try {
    for (let y = h - 1; y >= 0; y--) {
      for (let x = 0; x < l; x++) {
        for (let z = 0; z < w; z++) {
          if (stopRequested || inCombat) {
            isMiningCube = false;
            isBusy = false;
            return;
          }
          const pos = startPos.offset(x + 1, y, z);
          const block = bot.blockAt(pos);
          if (block && block.name !== 'air' && block.name !== 'bedrock' && block.diggable) {
            await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 3));
            const tool = bot.pathfinder.bestHarvestTool(block);
            if (tool) { try { await bot.equip(tool, 'hand'); } catch {} }
            await bot.dig(block);
          }
        }
      }
    }
    bot.chat(`/msg ${replyTo} Cube break complete!`);
  } catch {}
  isMiningCube = false;
  isBusy = false;
  purgeJunkItems();
}

bot.on('physicsTick', () => {
  try {
    if (!bot.entity || inCombat || isMiningCube) return;

    const threat = bot.nearestEntity((e) => e.type === 'player' && e.username !== bot.username && !isOwner(e.username) && bot.entity.position.distanceTo(e.position) <= CONFIG.dodgeDistance);
    if (threat) {
      isDodging = true;
      bot.pathfinder.setGoal(new GoalInvert(new GoalNear(threat.position.x, threat.position.y, threat.position.z, CONFIG.dodgeDistance + 2)), true);
      return;
    } else if (isDodging) {
      isDodging = false;
      bot.pathfinder.setGoal(null);
    }

    if (isBusy) return;

    if (hasValuableLoot()) {
      goToSafeZone(() => {
        if (mode === 'auto' || offlineMode) storeInEnderChest(false, activeOwner);
        else bot.chat(`/msg ${activeOwner} Loot aa gaya! !drop likho.`);
      });
      return;
    }

    const drop = bot.nearestEntity((e) => {
      if (e.name !== 'item') return false;
      const d = e.getDroppedItem();
      return d && getItemTier(d.name) > 0 && bot.entity.position.distanceTo(e.position) < 30;
    });
    if (drop) {
      bot.pathfinder.setGoal(new GoalNear(drop.position.x, drop.position.y, drop.position.z, 1));
      return;
    }

    if (offlineMode) {
      const { x, y, z } = zones.unsafeZone;
      const dist = bot.entity.position.distanceTo(new Vec3(x, y, z));
      if (dist > 18) bot.pathfinder.setGoal(new GoalNear(x, y, z, 3));
      else if (!bot.pathfinder.isMoving()) {
        bot.pathfinder.setGoal(new GoalNear(x + Math.floor(Math.random() * 21) - 10, y, z + Math.floor(Math.random() * 21) - 10, 1));
      }
    }
  } catch {}
});

async function checkOwnerAndRun(username, message) {
  if (!isOwner(username)) return;
  activeOwner = username;
  const text = message.trim();
  const args = text.split(/\s+/);
  const cmd = args[0].toLowerCase();

  if (cmd === '!safezone') {
    const o = bot.players[username]?.entity;
    if (!o) return bot.chat(`/msg ${username} Paas aakar !safezone likho.`);
    const p = o.position.floored();
    zones.safeZone = { x: p.x, y: p.y, z: p.z };
    saveZones();
    bot.chat(`/msg ${username} Safe Zone set: ${p.x}, ${p.y}, ${p.z}`);
  } else if (cmd === '!unsafezone') {
    const o = bot.players[username]?.entity;
    if (!o) return bot.chat(`/msg ${username} Paas aakar !unsafezone likho.`);
    const p = o.position.floored();
    zones.unsafeZone = { x: p.x, y: p.y, z: p.z };
    saveZones();
    bot.chat(`/msg ${username} Unsafe Zone set: ${p.x}, ${p.y}, ${p.z}`);
  } else if (cmd === '!setec') {
    const o = bot.players[username]?.entity;
    const ec = bot.findBlock({ point: o ? o.position : bot.entity.position, matching: (b) => b && b.name === 'ender_chest', maxDistance: 6 });
    if (!ec) return bot.chat(`/msg ${username} EC ke bilkul paas khade hokar !setec likho.`);
    zones.enderChestPos = { x: ec.position.x, y: ec.position.y, z: ec.position.z };
    saveZones();
    bot.chat(`/msg ${username} Ender Chest set: ${ec.position.x}, ${ec.position.y}, ${ec.position.z}`);
  } else if (cmd === '!offline') {
    offlineMode = true; mode = 'auto';
    bot.chat(`/msg ${username} OFFLINE MODE ON!`);
  } else if (cmd === '!online') {
    offlineMode = false; bot.pathfinder.setGoal(null);
    goToSafeZone(() => bot.chat(`/msg ${username} ONLINE MODE ON!`));
  } else if (cmd === '!hit') {
    const tName = args[1]?.toLowerCase(), cnt = args[2] ? Math.max(1, parseInt(args[2])) : 1;
    if (!tName) return;
    await equipBestWeapon();
    let done = 0;
    const iv = setInterval(async () => {
      if (done >= cnt || inCombat) return clearInterval(iv);
      const m = bot.nearestEntity((e) => e.type !== 'player' && e.name !== 'item' && bot.entity.position.distanceTo(e.position) <= 4.2 && e.name?.toLowerCase().includes(tName));
      if (m) { await bot.lookAt(m.position.offset(0, m.height * 0.8, 0)); bot.attack(m); done++; } else clearInterval(iv);
    }, 650);
  } else if (cmd === '!farm') {
    if (args[1] === 'on' && !farmInterval) {
      await equipBestWeapon();
      bot.chat(`/msg ${username} Mob Farm ON!`);
      farmInterval = setInterval(async () => {
        if (inCombat) return;
        const m = bot.nearestEntity((e) => (e.type === 'mob' || e.kind === 'Hostile mobs') && bot.entity.position.distanceTo(e.position) <= 4.2);
        if (m) { await bot.lookAt(m.position.offset(0, m.height * 0.8, 0)); bot.attack(m); }
      }, 650);
    } else if (args[1] === 'off') { clearInterval(farmInterval); farmInterval = null; bot.chat(`/msg ${username} Mob Farm OFF.`); }
  } else if (cmd === '!sethome') await runCommandAndClickGUI('/sethome', 'gray_bed', args[1] ? parseInt(args[1]) : 1, username);
  else if (cmd === '!home') await runCommandAndClickGUI('/home', 'blue_bed', args[1] ? parseInt(args[1]) : 1, username);
  else if (cmd === '!delhome') await runCommandAndClickGUI('/delhome', 'blue_bed', args[1] ? parseInt(args[1]) : 1, username);
  else if (cmd === '!gui' && args[1] && bot.currentWindow) {
    const t = bot.currentWindow.slots.find((i) => i && i.name.toLowerCase().includes(args[1].toLowerCase()));
    if (t) await bot.clickWindow(t.slot, 0, 0);
  } else if (cmd === '!slot' && args[1] && bot.currentWindow) await bot.clickWindow(parseInt(args[1]), 0, 0);
  else if (cmd === '!break') { const l = parseInt(args[1]), h = parseInt(args[2]), w = parseInt(args[3]); if (l > 0 && h > 0 && w > 0) breakCubeArea(l, h, w, username); }
  else if (cmd === '!stop') { stopRequested = true; isMiningCube = false; isBusy = false; offlineMode = false; clearInterval(farmInterval); farmInterval = null; bot.pathfinder.setGoal(null); bot.stopDigging(); bot.chat(`/msg ${username} Sab rok diya!`); }
  else if (cmd === '!inv' || cmd === '!inventory') bot.chat(`/msg ${username} [inventory]`);
  else if (cmd === '!ec') storeInEnderChest(true, username);
  else if (cmd === '!openec') openEnderChestOnly(username);
  else if (cmd === '!get' && args[1]) getItemFromEC(args[1], args[2] ? parseInt(args[2]) : null, username);
  else if (cmd === '!drop') dropAllItems(username);
  else if (cmd === '!dropall') withdrawAllAndDrop(username);
  else if (cmd === '!dropitem' && args[1]) {
    const t = bot.inventory.items().find((i) => i.name.toLowerCase().includes(args[1].toLowerCase()));
    if (t) await bot.toss(t.type, null, args[2] ? Math.min(parseInt(args[2]), t.count) : t.count);
  } else if (cmd === '!equip' && args[1]) {
    const i = bot.inventory.items().find((x) => x.name.toLowerCase().includes(args[1].toLowerCase()));
    if (i) { try { await bot.equip(i, args[2] || 'hand'); } catch {} }
  } else if (cmd === '!armor') { await equipBestArmor(); bot.chat(`/msg ${username} Best armor pehen liya!`); }
  else if (cmd === '!eat') {
    const f = bot.inventory.items().find((i) => ['golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop', 'golden_carrot', 'bread', 'cooked_chicken'].some((x) => i.name.includes(x)));
    if (f) { await bot.equip(f, 'hand'); await bot.consume(); }
  } else if (cmd === '!come') {
    offlineMode = false;
    const o = bot.players[username]?.entity;
    if (o) {
      bot.pathfinder.setGoal(new GoalNear(o.position.x, o.position.y, o.position.z, 2));
      bot.chat(`/msg ${username} Aa raha hoon!`);
    } else {
      bot.chat(`/msg ${username} Tum paas nahi dikh rahe! /tpahere SpicyLoot_99 bhejo.`);
    }
  } else if (cmd === '!follow') {
    offlineMode = false;
    const o = bot.players[username]?.entity;
    if (o) {
      bot.pathfinder.setGoal(new GoalFollow(o, 2), true);
      bot.chat(`/msg ${username} Ab tumhe follow kar raha hoon! Wapas auto-roam ke liye !offline likhna.`);
    } else {
      bot.chat(`/msg ${username} Tum render distance mein nahi ho!`);
    }
  } else if (cmd === '!unfollow') bot.pathfinder.setGoal(null);
  else if (cmd === '!spawn') goToSafeZone(() => bot.chat(`/msg ${username} Safe zone aa gaya.`));
  else if (cmd === '!tpa') bot.chat(`/tpa ${args[1] || username}`);
  else if (cmd === '!tpaccept') bot.chat('/tpaccept');
  else if (cmd === '!warp' && args[1]) bot.chat(`/warp ${args[1]}`);
  else if (cmd === '!kit' && args[1]) bot.chat(`/kit ${args[1]}`);
  else if (cmd === '!look' && args.length >= 4) bot.lookAt(new Vec3(parseFloat(args[1]), parseFloat(args[2]), parseFloat(args[3])));
  else if (cmd === '!say' && args.length > 1) bot.chat(text.slice(5));
  else if (cmd === '!status') { const p = bot.entity.position.floored(); bot.chat(`/msg ${username} HP:${Math.round(bot.health)} Food:${bot.food} Pos:${p.x},${p.y},${p.z} Offline:${offlineMode}`); }
  else if (cmd === '!mode' && (args[1] === 'auto' || args[1] === 'hold')) { mode = args[1]; bot.chat(`/msg ${username} Mode: ${mode.toUpperCase()}`); }
  else if (cmd === '!cmd' && args.length > 1) bot.chat(text.slice(5));
}

bot.on('chat', checkOwnerAndRun);
bot.on('whisper', checkOwnerAndRun);
bot.on('kicked', (reason) => console.log('Kicked:', reason));
bot.on('error', (err) => console.log('Error:', err));
      
