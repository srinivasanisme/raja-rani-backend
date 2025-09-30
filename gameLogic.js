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

// Initial points in descending order
const START_POINTS = [20000, 18000, 16000, 14000, 12000, 10000, 8000, 6000, 4000, 0];

// 🎮 Init game state
function initGame() {
  let players = ROLE_ORDER.map((role, i) => ({
    id: `${i + 1}`, // simple string id
    name: role,
    role,
    points: START_POINTS[i],
    active: role === "Raja", // Raja always starts
    done: false,
  }));

  return {
    players,
    currentRoleIndex: 0,
    roundActive: true,
  };
}

// ✅ Correct catch
function handleCorrectCatch(state, catcher, target, io) {
  catcher.points += target.points;
  catcher.done = true;
  target.done = true;
  catcher.active = false;
  target.active = false;

  // Next role
  let nextRoleIndex = (ROLE_ORDER.indexOf(target.role) + 1) % ROLE_ORDER.length;
  let nextPlayer = state.players.find(
    (p) => p.role === ROLE_ORDER[nextRoleIndex] && !p.done
  );
  if (nextPlayer) nextPlayer.active = true;

  io.emit("catch_result", { type: "correct", catcher, target });
  return state;
}

// ❌ Wrong catch → swap roles
function handleWrongCatch(state, catcher, target, io) {
  let temp = catcher.role;
  catcher.role = target.role;
  target.role = temp;

  io.emit("catch_result", { type: "wrong", catcher, target });
  return state;
}

// 💤 Catch inactive player
function handleInactiveCatch(state, catcher, target, io) {
  target.points += catcher.points;
  catcher.points = 0;
  catcher.done = true;
  catcher.active = false;

  io.emit("catch_result", { type: "inactive_target", catcher, target });
  return state;
}

// ⏳ Timeout → pass turn
function handleTimeout(state, playerId, io) {
  let player = state.players.find((p) => p.id === playerId);
  if (player) {
    player.active = false;
    let nextRoleIndex = (ROLE_ORDER.indexOf(player.role) + 1) % ROLE_ORDER.length;
    let nextPlayer = state.players.find(
      (p) => p.role === ROLE_ORDER[nextRoleIndex] && !p.done
    );
    if (nextPlayer) nextPlayer.active = true;

    io.emit("turn_timeout", { player });
  }
  return state;
}

// 🎯 Handle catch
function handleCatch(state, catcherId, targetId, io) {
  let catcher = state.players.find((p) => p.id === catcherId);
  let target = state.players.find((p) => p.id === targetId);
  if (!catcher || !target) return state;

  let expectedRoleIndex = (ROLE_ORDER.indexOf(catcher.role) + 1) % ROLE_ORDER.length;
  let expectedRole = ROLE_ORDER[expectedRoleIndex];

  if (target.done) {
    return handleInactiveCatch(state, catcher, target, io);
  } else if (target.role === expectedRole) {
    return handleCorrectCatch(state, catcher, target, io);
  } else {
    return handleWrongCatch(state, catcher, target, io);
  }
}

function getGameState(state) {
  return state;
}

module.exports = { initGame, handleCatch, handleTimeout, getGameState };
