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
      bot.chat(`/login ${CONFIG.password}`);
      console.log('Force sent: /login');
    } catch {}
  }, 4500);
}

bot.on('login', () => {
  console.log('Server login packet received! Force login in 4.5s...');
  sendForceAuth();
});

bot.on('message', (jsonMsg, position) => {
  const cleanText = jsonMsg.toString().trim();
  if (cleanText) {
    console.log(`[${position || 'CHAT'}] ${cleanText}`);
  }
});

bot.on('title', (text) => {
  console.log('[TITLE]', text);
});

bot.on('actionBar', (jsonMsg) => {
  const actionText = jsonMsg.toString();
  console.log('[ACTIONBAR]', actionText);

  const lower = actionText.toLowerCase();
  if (lower.includes('combat')) {
    const timeMatch = actionText.match(/(\d+(\.\d+)?)\s*s/);
    combatEndTime = timeMatch
      ? Date.now() + parseFloat(timeMatch[1]) * 1000 + 500
      : Date.now() + COMBAT_DURATION_MS;
    if (!inCombat) triggerCombatState();
  }
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
  const p = bot.entity ? bot.entity.position.floored() : { x: 0, y: 0, z: 0 };
  console.log(`[SPAWN] Dimension: ${bot.game.dimension} | Pos: ${p.x}, ${p.y}, ${p.z}`);

  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);
  defaultMove.canDig = false;
  bot.pathfinder.setMovements(defaultMove);
  isBusy = false;

  if (!fs.existsSync(ZONES_FILE)) {
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

 
