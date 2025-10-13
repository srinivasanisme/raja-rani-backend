// server/index.js
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });
// ---------------- GAME STATE ----------------
let game = {
  round: 0,
  players: [], // { name, score, socketId, finishedThisRound:false, inactive:false }
  roles: {},   // { name: roleString }
  activePlayer: null, // { name, socketId } or null
  history: [],
  roundActive: false,
  admin: null, // 🔥 Admin socketId
};
let turnTimer = null;       // ⏱ single-turn timeout
let timerInterval = null;   // ⏳ for 1-sec countdown

// Role order and points
const ROLE_ORDER = [
  "Raja",
  "Rani",
  "PM",
  "CM",
  "D-CM",
  "Minister",
  "MP",
  "MLA",
  "Police",
  "Thief",
];

const ROLE_POINTS = {
  Raja: 10000,
  Rani: 9000,
  PM: 8000,
  CM: 7000,
  "D-CM": 6000,
  Minister: 5000,
  MP: 3500,
  MLA: 2000,
  Police: 1000,
  Thief: 0,
};

// ---------------- HELPERS ----------------
function broadcastPublic() {
  const publicPlayers = game.players.map((p) => ({
    name: p.name,
    score: p.score,
    finishedThisRound: !!p.finishedThisRound,
  }));

  const rolesPublic = {};
  Object.keys(game.roles).forEach((name) => {
    rolesPublic[name] =
      game.activePlayer && game.activePlayer.name === name
        ? game.roles[name]
        : "?????";
  });

   // find admin name if admin set
  const adminName =
    game.admin && game.players.find((p) => p.socketId === game.admin)
      ? game.players.find((p) => p.socketId === game.admin).name
      : null;

  io.emit("state", {
    round: game.round,
    players: publicPlayers,
    rolesPublic,
    activePlayer: game.activePlayer ? { name: game.activePlayer.name } : null,
    history: game.history,
    roundActive: game.roundActive,
    admin: game.admin,
    adminName,
  });
}

function sendPrivateRole(socket, playerName) {
  socket.emit("yourRole", {
    role: game.roles[playerName] || null,
    round: game.round,
  });
}

// ✅ TIMER LIMITS
const TURN_TIME_LIMIT = 20000;  // 20 sec per player

// ✅ Timer state
const gameState = {
  currentRole: null,
  currentRoleStartTime: null,
  roleTimer: null,

  currentTurnPlayerId: null,
  currentTurnStartTime: null,
  turnTimer: null,
};



function clearTurnTimer() {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// Add this right below:
function clearTurnTimers() {
  clearTurnTimer();
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isRoundComplete() {
  return game.players.every(p => p.inactive);
}

function endRoundAndShowScoreboard() {
  clearTurnTimer();
  game.roundActive = false;
  game.activePlayer = null;

  console.log("🏁 Round ended → Broadcasting scoreboard");

  io.emit("roundSummary", {
    round: game.round,
    summary: game.players.map((p) => ({
      name: p.name,
      role: game.roles[p.name],
      score: p.score,
    })),
  });

  broadcastPublic();
}


function advanceToNextActive(startFromRaja = false) {
  clearTurnTimer();

  // 🕵 If current active was Police → end round automatically
  if (game.activePlayer) {
    const currentRole = game.roles[game.activePlayer.name];
    if (currentRole === "Police") {
      console.log("🚨 Police finished → Ending round & showing scoreboard");
      endRoundAndShowScoreboard();
      return;
    }
  }

  // 🔍 Filter players who are still in the round
  const unfinished = game.players.filter(p => !p.inactive);
  if (unfinished.length === 0) {
    endRoundAndShowScoreboard();
    return;
  }

  // 🟡 Start fresh from Raja (first turn of round)
  if (startFromRaja || !game.activePlayer) {
    const raja = unfinished.find(p => game.roles[p.name] === "Raja");
    if (raja) {
      game.activePlayer = { name: raja.name, socketId: raja.socketId };
    } else {
      const fallback = unfinished[0];
      game.activePlayer = { name: fallback.name, socketId: fallback.socketId };
    }
  } else {
    // 🔄 Find next active based on ROLE_ORDER but skip Thief
    const curRole = game.roles[game.activePlayer.name];
    const curIndex = ROLE_ORDER.indexOf(curRole);

    let found = false;
    for (let i = 1; i <= ROLE_ORDER.length; i++) {
      const nextRole = ROLE_ORDER[(curIndex + i) % ROLE_ORDER.length];

      // ❌ Skip Thief here → no turn for Thief ever
      if (nextRole === "Thief") continue;

      const nextPlayer = unfinished.find(p => game.roles[p.name] === nextRole);
      if (nextPlayer) {
        game.activePlayer = { name: nextPlayer.name, socketId: nextPlayer.socketId };
        found = true;
        break;
      }
    }

    // 🛑 Fallback if no suitable role found (should rarely happen)
    if (!found) {
      const fallback = unfinished[0];
      game.activePlayer = { name: fallback.name, socketId: fallback.socketId };
    }
  }

  // 🌐 Broadcast updated active player to everyone
  broadcastPublic();
  io.emit("activePlayer", { player: game.activePlayer.name });

  // ⏱️ Start timer for the new active player
  startTurnForActive(TURN_TIME_LIMIT);
}


function isRoundComplete() {
  return game.players.every((p) => p.inactive);
}


function handleRoleTimeout(role) {
  console.log(`${role} role timed out`);
  markRoleInactive(role);
  const nextRole = getNextRole(role);
  activateNextRole(nextRole);
  io.emit("roleTimedOut", { role, nextRole });
}

function startTurnTimer(playerId) {
  clearTurnTimer();
  gameState.currentTurnPlayerId = playerId;
  gameState.currentTurnStartTime = Date.now();

  gameState.turnTimer = setTimeout(() => {
    handlePlayerTimeout(playerId);
  }, TURN_TIME_LIMIT);
}

function handlePlayerTimeout(playerId) {
  const player = game.players.find(p => p.socketId === playerId);
  if (!player) return;

  player.inactive = true;

  // Log timeout
  game.history.push({
    text: `⏳ ${game.roles[player.name]} (${player.name}) timed out → inactive (0 pts)`,
    type: "timeout",
  });

  // ✅ Skip Thief if inactive
  if (game.roles[player.name] === "Thief") {
    advanceToNextActive(); // next active player (likely Police)
  } else {
    moveToNextPlayerTurn();
  }

  broadcastPublic();
}

function broadcastTimers() {
  if (gameState.currentRoleStartTime) {
    const elapsed = Date.now() - gameState.currentRoleStartTime;
    const remaining = Math.max(0, ROLE_TIME_LIMIT - elapsed);
    io.emit("roleTimerUpdate", { remaining });
  }

  if (gameState.currentTurnStartTime) {
    const elapsed = Date.now() - gameState.currentTurnStartTime;
    const remaining = Math.max(0, TURN_TIME_LIMIT - elapsed);
    io.emit("turnTimerUpdate", { remaining });
  }
}
setInterval(broadcastTimers, 1000);

function getNextRole(currentRole) {
  const idx = ROLE_ORDER.indexOf(currentRole);
  return ROLE_ORDER[(idx + 1) % ROLE_ORDER.length];
}

function markRoleInactive(role) {
  const player = game.players.find(p => game.roles[p.name] === role);
  if (player) player.inactive = true;
}

function markPlayerInactive(playerId) {
  const player = game.players.find(p => p.socketId === playerId);
  if (player) player.inactive = true;
}

function moveToNextPlayerTurn() {
  // Reuse your advanceToNextActive() logic here
  advanceToNextActive();
}

  // Start the countdown for the current game.activePlayer using the global turnTimer / timerInterval
function startTurnForActive(durationMs = TURN_TIME_LIMIT) {
  clearTurnTimer(); // stops any previous timers

  if (!game.activePlayer) return;

  // Find the player object (so we can mark inactive later)
  const ap = game.players.find((p) => p.name === game.activePlayer.name);
  if (!ap) return;

  // notify clients timer started
  io.emit("timerStart", { player: ap.name, timeLeft: durationMs });

  // per-second updates
  let remainingMs = durationMs;
  timerInterval = setInterval(() => {
    remainingMs -= 1000;
    if (remainingMs <= 0) {
      clearTurnTimer();
      return;
    }
    io.emit("timerUpdate", { player: ap.name, timeLeft: remainingMs });
  }, 1000);

  // final timeout
  turnTimer = setTimeout(() => {
    // mark player inactive and log
    ap.inactive = true;
    game.history.push({
      text: `⏳ ${game.roles[ap.name]} (${ap.name}) timed out → inactive (0 pts)`,
      type: "timeout",
    });

    // end round or advance to next role in exact ROLE_ORDER
    if (isRoundComplete()) {
      game.roundActive = false;
    } else {
      advanceToNextActive(); // will pick next role in order
    }

    clearTurnTimer();
    broadcastPublic();
  }, durationMs);
}

function activateNextRole(nextRole) {
  // activate next role — basically same as advanceToNextActive()
  advanceToNextActive();
}

// ---------------- SOCKET.IO ----------------
io.on("connection", (socket) => {
   console.log("New connection:", socket.id);
  socket.emit("state", {
    round: game.round,
    players: game.players.map((p) => ({
      name: p.name,
      score: p.score,
      finishedThisRound: !!p.finishedThisRound,
    })),
    rolesPublic: Object.fromEntries(
      Object.keys(game.roles).map((n) => [
        n,
        game.activePlayer && game.activePlayer.name === n
          ? game.roles[n]
          : "?????",
      ])
    ),
    activePlayer: game.activePlayer ? { name: game.activePlayer.name } : null,
    history: game.history,
    roundActive: game.roundActive,
    admin: game.admin,
    adminName: game.players.find(p => p.socketId === game.admin)?.name || null,
  });



// Add player
  socket.on("joinGame", ({ name, isAdmin }, cb) => {
    name = name?.trim();
    if (!name) return cb?.({ success: false, error: "Invalid name" });
    if (game.players.find((p) => p.name === name))
      return cb?.({ success: false, error: "Name taken" });
    if (game.players.length >= 10) return cb?.({ success: false, error: "Max 10 players" });

    const isPlayerAdmin = isAdmin && !game.admin;

game.players.push({
  name,
  score: 0,
  socketId: socket.id,
  inactive: false,
  isAdmin: isPlayerAdmin,
});

// If first admin, mark global admin
if (isPlayerAdmin) game.admin = socket.id;

    game.history.push({
      text: `✳ ${name} joined`,
      type: "roundEvent"
    });
    broadcastPublic();
    cb?.({ success: true });
  });

  socket.on("requestRole", (playerName) => {
    sendPrivateRole(socket, playerName);
  });

  // Start round
socket.on("startRound", (cb) => {
  if (socket.id !== game.admin)
    return cb?.({ success: false, error: "Only admin can start" });

  // ✅ Require exactly 10 human players
  if (game.players.length !== 10) {
    return cb?.({ success: false, error: "Exactly 10 players required to start the round" });
  }

  // 🟢 Start the round
  game.round++;
  game.players.forEach((p) => {
    p.inactive = false;
    p.scoredOnce = false;
  });

  game.roles = {};
  game.history.push({
    text: `⚡ Round ${game.round} started`,
    type: "roundEvent",
  });
  game.roundActive = true;

  // 🌀 Shuffle roles and assign to each of the 10 players
  const shuffled = shuffleArray(ROLE_ORDER);
  for (let i = 0; i < game.players.length; i++) {
    game.roles[game.players[i].name] = shuffled[i % shuffled.length];
  }

  // 👑 Start with Raja
  advanceToNextActive(true);
  startTurnForActive(TURN_TIME_LIMIT);
  broadcastPublic();

  cb?.({ success: true });
});


  // Attempt catch
  socket.on("attemptCatch", ({ catcherName, targetName }, cb) => {
    if (!game.roundActive) return cb?.({ success: false });
    clearTurnTimers();
    const catcher = game.players.find(
      (p) => p.socketId === socket.id && p.name === catcherName
    );
    const target = game.players.find((p) => p.name === targetName);

    if (!catcher || !target) return cb?.({ success: false, error: "Invalid players" });
    if (!game.roundActive) return cb?.({ success: false, error: "No active round" });
    if (game.activePlayer?.name !== catcherName)
      return cb?.({ success: false, error: "Not your turn" });

    const expectedMap = {
      Raja: "Rani",
      Rani: "PM",
      PM: "CM",
      CM: "D-CM",
      "D-CM": "Minister",
      Minister: "MP",
      MP: "MLA",
      MLA: "Police",
      Police: "Thief",
      Thief: "Raja",
    };

    const catcherRole = game.roles[catcherName];
    const targetRole = game.roles[targetName];
    const expectedRole = expectedMap[catcherRole];
    const catcherPoints = ROLE_POINTS[catcherRole] || 0;
    const targetPoints = ROLE_POINTS[targetRole] || 0;

    // 1️⃣ Catching an inactive player
if (target.inactive) {
  // Special case: Police catching inactive (non-Thief)
  if (catcherRole === "Police" && targetRole !== "Thief") {
    // Police inactive, 0 points
    catcher.score = 0;
    catcher.inactive = true;

    // Find Thief and transfer points Police would have earned
    const thiefPlayer = game.players.find(p => game.roles[p.name] === "Thief");
    if (thiefPlayer) thiefPlayer.score += ROLE_POINTS["Police"];

    game.history.push({
      text: `⚠ Police (${catcherName}) caught inactive ${targetRole} → 0 pts, points transferred to Thief (${thiefPlayer?.name})`,
      type: "neutral",
    });

    advanceToNextActive(); // next active player, skip Police
    broadcastPublic();
    return cb?.({ success: false, error: "police_inactive" });
  }

  // Normal inactive catch (non-Police)
  target.score += catcherPoints; // transfer points
  catcher.inactive = true;

  game.history.push({
    text: `⚠ ${catcherRole} (${catcherName}) caught inactive ${targetRole} (${targetName}) → points transferred, catcher inactive`,
    type: "neutral"
  });

  advanceToNextActive();
  broadcastPublic();
  return cb?.({ success: false, error: "already inactive" });
}

  // 2️⃣ Correct catch
  if (targetRole === expectedRole) {
    catcher.score += catcherPoints;
    catcher.inactive = true;

    // Special Police → Thief logic
    if (catcherRole === "Police" && targetRole === "Thief") {
      const thiefPlayer = game.players.find(p => game.roles[p.name] === "Thief");
      if (thiefPlayer) {
        thiefPlayer.inactive = true;
        thiefPlayer.score = 0;
      }
      game.roundActive = false;
      clearTurnTimer();

      game.history.push({
        text: `✅ Police (${catcherName}) correctly caught Thief (${targetName}) → +${catcherPoints}, Thief inactive`,
        type: "correct"
      });

      broadcastPublic();
      io.emit("roundSummary", {
        round: game.round,
        summary: game.players.map((p) => ({
          name: p.name,
          role: game.roles[p.name],
          score: p.score,
        })),
      });

      return cb?.({ success: true });
    }

    // Normal roles
    game.history.push({
      text: `✅ ${catcherRole} (${catcherName}) correctly caught ${targetRole} (${targetName}) → +${catcherPoints}`,
      type: "correct"
    });

    if (catcherRole === "Raja") {
      game.activePlayer = { name: targetName, socketId: target.socketId };
    } else {
      advanceToNextActive();
    }

    broadcastPublic();

    // If catcher scored 0 points → show zero/duck
    if (catcherPoints === 0) {
      return cb?.({ success: false, error: "zero" });
    }

    return cb?.({ success: true });
  }


 // 3️⃣ Wrong catch
  if (catcherRole === "Police") {
    const thiefPlayer = game.players.find(p => game.roles[p.name] === "Thief");
    if (thiefPlayer) thiefPlayer.score += 1000;
    game.history.push({
      text: `❌ Police (${catcherName}) wrong catch → swapped with ${targetName}, Thief (${thiefPlayer?.name}) +1000 pts`,
      type: "wrong",
    });
    // ✅ End round immediately — no swapping, no next turn
  endRoundAndShowScoreboard();
  return cb?.({ success: false, error: "police_wrong_end" });
  } else {
    game.history.push({
      text: `❌ ${catcherRole} (${catcherName}) wrong catch → swapped with ${targetName}`,
      type: "wrong",
    });
  }

  // Swap roles
  [game.roles[catcherName], game.roles[targetName]] = [game.roles[targetName], game.roles[catcherName]];

  // New active player is the target
  game.activePlayer = { name: targetName, socketId: target.socketId };

  broadcastPublic();

  // ✅ Restart centralized 20s turn timer for new active player
  startTurnForActive(TURN_TIME_LIMIT);

  return cb?.({ success: false, error: "wrong" });
});

  socket.on("forceEnd", (cb) => {
    if (socket.id !== game.admin)
    return cb?.({ success: false, error: "Only admin can force-end" });
    if (!game.roundActive) return cb?.({ success: false, error: "No active round" });
    game.roundActive = false;
    game.players.forEach((p) => (p.inactive = true));
    game.history.push({
      text: `⚡ Round ${game.round} force-ended`,
      type: "roundEvent"
    });
    if (turnTimer) {
      clearTimeout(turnTimer);
      turnTimer = null;
    }
    io.emit("roundSummary", {
      round: game.round,
      summary: game.players.map((p) => ({
        name: p.name,
        role: game.roles[p.name],
        score: p.score,
      })),
    });
    clearTurnTimer();
    broadcastPublic();
    cb?.({ success: true });
  });

        // Feedback from a player
socket.on("sendFeedback", (data) => {
  const { player, text } = data;
  if (!text || !player) return;

  const feedbackMsg = { player, text };
  
  // Broadcast to all clients
  io.emit("newFeedback", feedbackMsg);
});


  socket.on("disconnect", () => {
  const idx = game.players.findIndex((p) => p.socketId === socket.id);
  if (idx !== -1) {
    const removed = game.players.splice(idx, 1)[0];

    // Log the disconnect
    game.history.push({
      text: `✖ ${removed.name} disconnected`,
      type: "roundEvent"
    });

    // Reassign admin if the disconnected player was the admin
    if (socket.id === game.admin) {
      const newAdmin = game.players[0] || null;
      game.admin = newAdmin?.socketId || null;
      if (newAdmin) newAdmin.isAdmin = true;

      game.history.push({
        text: `🔑 ${newAdmin?.name || 'No players'} is now the admin`,
        type: "roundEvent"
      });
    }

    // Handle active player leaving
    if (game.activePlayer?.socketId === socket.id) {
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
      advanceToNextActive();
    }

    // Notify all clients
    broadcastPublic();
  }
  console.log("Client disconnected:", socket.id);
});
 });

// start server
const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));