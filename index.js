// server/index.cjs
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });
let turnTimer = null;
let timerInterval = null;
// ---------------- GAME STATE ----------------
let game = {
  round: 0,
  players: [], // { name, score, socketId, finishedThisRound:false, inactive:false }
  roles: {},   // { name: roleString }
  activePlayer: null, // { name, socketId } or null
  history: [],
  roundActive: false,
};

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

  io.emit("state", {
    round: game.round,
    players: publicPlayers,
    rolesPublic,
    activePlayer: game.activePlayer ? { name: game.activePlayer.name } : null,
    history: game.history,
    roundActive: game.roundActive,
  });
}

function sendPrivateRole(socket, playerName) {
  socket.emit("yourRole", {
    role: game.roles[playerName] || null,
    round: game.round,
  });
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function advanceToNextActive() {
  const unfinished = game.players.filter((p) => !p.inactive);
  if (unfinished.length === 0) {
    game.activePlayer = null;
    return;
  }

  // Determine next active player
  if (!game.activePlayer) {
    const raja = unfinished.find((p) => game.roles[p.name] === "Raja");
    game.activePlayer = raja
      ? { name: raja.name, socketId: raja.socketId }
      : { name: unfinished[0].name, socketId: unfinished[0].socketId };
  } else {
    const currentRole = game.roles[game.activePlayer.name];
    const curIndex = ROLE_ORDER.indexOf(currentRole);
    for (let i = 1; i <= ROLE_ORDER.length; i++) {
      const nextRole = ROLE_ORDER[(curIndex + i) % ROLE_ORDER.length];
      const nextPlayer = unfinished.find((p) => game.roles[p.name] === nextRole);
      if (nextPlayer) {
        game.activePlayer = { name: nextPlayer.name, socketId: nextPlayer.socketId };
        break;
      }
    }
  }

  // ✅ Reset previous timers
  if (turnTimer) clearTimeout(turnTimer);
  if (timerInterval) clearInterval(timerInterval);

  // Start countdown for active player
  if (game.activePlayer) {
    let timeLeft = 15; // seconds
    io.emit("timerUpdate", timeLeft); // send initial value immediately

    timerInterval = setInterval(() => {
      timeLeft--;
      if (timeLeft >= 0) io.emit("timerUpdate", timeLeft);
      if (timeLeft <= 0) clearInterval(timerInterval);
    }, 1000);

    // Enforce timeout
    turnTimer = setTimeout(() => {
      const ap = game.players.find((p) => p.name === game.activePlayer.name);
      if (ap && !ap.inactive) {
        ap.inactive = true;
        game.history.push({
          text: `⏳ ${game.roles[ap.name]} (${ap.name}) timed out → inactive (0 pts)`,
          type: "timeout",
        });
        advanceToNextActive();
        if (isRoundComplete()) game.roundActive = false;
        broadcastPublic();
      }
    }, 15000);
  }
}

function isRoundComplete() {
  return game.players.every((p) => p.inactive);
}

// ---------------- SOCKET.IO ----------------
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

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
  });

  // Add player
  socket.on("addPlayer", (name, cb) => {
    name = name?.trim();
    if (!name) return cb?.({ success: false, error: "Invalid name" });
    if (game.players.find((p) => p.name === name))
      return cb?.({ success: false, error: "Name taken" });
    if (game.players.length >= 10) return cb?.({ success: false, error: "Max 10 players" });

    game.players.push({
      name,
      score: 0,
      socketId: socket.id,
      inactive: false,
    });
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
    if (game.players.length !== 10)
      return cb?.({ success: false, error: "Need exactly 10 players" });

    game.round++;
    game.players.forEach((p) => {
      p.inactive = false;
      p.scoredOnce = false;
    });
    game.roles = {};
    game.history.push({
      text: `⚡ Round ${game.round} started`,
      type: "roundEvent"
    });
    game.roundActive = true;

    const shuffled = shuffleArray(ROLE_ORDER);
    for (let i = 0; i < game.players.length; i++) {
      game.roles[game.players[i].name] = shuffled[i % shuffled.length];
    }

    // Start with Raja
    advanceToNextActive();
    broadcastPublic();
    cb?.({ success: true });
  });

  // Attempt catch
  socket.on("attemptCatch", ({ catcherName, targetName }, cb) => {
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

    // Catching inactive player
    if (target.inactive) {
      target.score += catcherPoints; // transfer points
      catcher.inactive = true;
      game.history.push({
        text: `⚠ ${catcherRole} (${catcherName}) caught inactive ${targetRole} (${targetName}) → points transferred, catcher inactive`,
        type: "neutral"
      });
      advanceToNextActive();
      if (isRoundComplete()) game.roundActive = false;
      broadcastPublic();
      return cb?.({ success: false, error: "already" }); // 🚫
    }

    // Correct catch
    if (targetRole === expectedRole) {
      catcher.score += catcherPoints;
      catcher.inactive = true; 
      game.history.push({
        text: `✅ ${catcherRole} (${catcherName}) correctly caught ${targetRole} (${targetName}) → +${catcherPoints}`,
        type: "correct"
      });

      if (catcherRole === "Raja") {
        game.activePlayer = { name: targetName, socketId: target.socketId };
      } else if (catcherRole === "Police") {
        // Round ends after Police catches Thief correctly
        game.players.forEach((p) => (p.inactive = true));
        game.roundActive = false;
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
        broadcastPublic();
        return cb?.({ success: true });
      } else {
        advanceToNextActive();
      }
      broadcastPublic();
      // If catcher scored 0 → duck/egg
    if (catcherPoints === 0) {
      return cb?.({ success: false, error: "zero" }); // 🥚
    }

    return cb?.({ success: true }); // 🎉
    }

    // Wrong catch → swap roles
    [game.roles[catcherName], game.roles[targetName]] = [
      game.roles[targetName],
      game.roles[catcherName],
    ];
    game.activePlayer = { name: targetName, socketId: target.socketId };
    game.history.push({
      text: `❌ ${catcherRole} (${catcherName}) wrong catch → swapped with ${targetName}`,
      type: "wrong"
    });

    if (isRoundComplete()) game.roundActive = false;
    broadcastPublic();
    cb?.({ success: false, error: "wrong" }); // ❌
  });

  socket.on("forceEnd", (cb) => {
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
    broadcastPublic();
    cb?.({ success: true });
  });

  socket.on("disconnect", () => {
    const idx = game.players.findIndex((p) => p.socketId === socket.id);
    if (idx !== -1) {
      const removed = game.players.splice(idx, 1)[0];
      game.history.push({
        text: `✖ ${removed.name} disconnected`,
        type: "roundEvent"
      });
      if (game.activePlayer?.socketId === socket.id) {
        if (turnTimer) {
          clearTimeout(turnTimer);
          turnTimer = null;
        }
        advanceToNextActive();
      }
      broadcastPublic();
    }
    console.log("Client disconnected:", socket.id);
  });
});

// start server
const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
