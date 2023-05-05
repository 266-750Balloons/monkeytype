import * as Notifications from "../elements/notifications";
import Config, * as UpdateConfig from "../config";
import * as DB from "../db";
import * as TribePages from "./tribe-pages";
import * as TribePagePreloader from "./pages/tribe-page-preloader";
import * as TribePageMenu from "./pages/tribe-page-menu";
import * as TribePageLobby from "./pages/tribe-page-lobby";
import * as TribeSound from "./tribe-sound";
import * as TribeChat from "./tribe-chat";
import * as TribeConfig from "./tribe-config";
import * as TribeCountdown from "./tribe-countdown";
import * as TimerEvent from "../observables/timer-event";
import * as TribeBars from "./tribe-bars";
import * as TribeResults from "./tribe-results";
import * as TribeUserList from "./tribe-user-list";
import * as TribeButtons from "./tribe-buttons";
import * as TribeStartRacePopup from "../popups/tribe-start-race-popup";
import * as TribeChartController from "./tribe-chart-controller";
import * as TribeDelta from "./tribe-delta";
import * as TestState from "../test/test-state";
import { navigate } from "../observables/navigate-event";
import * as Random from "../utils/random";
import TribeSocket from "./tribe-socket";
import * as ActivePage from "../states/active-page";
import * as TribeState from "./tribe-state";
import { escapeRegExp, escapeHTML } from "../utils/misc";
import * as Time from "../states/time";
import * as TestWords from "../test/test-words";
import * as TestStats from "../test/test-stats";
import * as TestInput from "../test/test-input";
import * as TribeCarets from "./tribe-carets";

const defaultName = "Guest";
let name = "Guest";

export const expectedVersion = "0.13.4";

let autoJoin: string | undefined = undefined;

export function setAutoJoin(code: string): void {
  autoJoin = code;
}

export function getStateString(state: number): string {
  if (state === -1) return "error";
  if (state === 1) return "connected";
  if (state === 5) return "lobby";
  if (state === 10) return "preparing race";
  if (state === 11) return "race countdown";
  if (state === 12) return "race active";
  if (state === 20) return "at least one finished";
  if (state === 21) return "everyone finished";
  if (state === 22) return "everyone ready / timer over";
  return "Unknown state " + state;
}

function updateState(newState: number): void {
  const room = TribeState.getRoom();
  if (room) room.state = newState;
  TribeState.setState(newState);

  const state = TribeState.getState();

  $("#tribeStateDisplay").text(`${state} - ${getStateString(state)}`);

  if (state === 5) {
    TribePageLobby.enableNameVisibilityButtons();
    TribeBars.hide("tribe");
  } else if (state === 10) {
    TribeButtons.disableStartButton("lobby");
    TribeButtons.disableReadyButton("lobby");
    TribePageLobby.disableConfigButtons();
    TribePageLobby.disableNameVisibilityButtons();
    const self = TribeState.getSelf();
    if (self && (self.isReady || self.isLeader)) {
      Notifications.add("Race is starting...", 1, undefined, "Tribe");
    }
  } else if (state === 11) {
    if (room?.users) {
      for (const user of Object.values(room.users)) {
        delete user.result;
        delete user.progress;
        delete user.isFinished;
        delete user.isTyping;
        if ((user.isReady || user.isLeader) && !user.isAfk) {
          user.isTyping = true;
          user.isFinished = false;
        }
      }
    }
    $("#tribeMiniChartCustomTooltip").remove();
    TribeUserList.update("lobby");
    TribeChartController.destroyAllCharts();
  } else if (state === 12) {
    if (room?.users) {
      for (const user of Object.values(room.users)) {
        if (user.isReady) {
          user.isReady = false;
        }
      }
    }
  } else if (state === 20) {
    if (TestState.isActive) {
      TribeCountdown.update("");
      TribeCountdown.show(true);
    } else {
      TribeResults.updateTimerText("Time left for everyone to finish");
    }
  } else if (state === 21) {
    TribeResults.hideTimer();
    TribeResults.updateTimerText("Time left for everyone to get ready");
    if (TribeState.getAutoReady() === true) {
      TribeSocket.out.room.readyUpdate();
    }
  } else if (state === 22) {
    TribePageLobby.enableNameVisibilityButtons();
    TribePageLobby.enableConfigButtons();
    TribeButtons.update();
  }
}

export async function init(): Promise<void> {
  TribePagePreloader.updateIcon("circle-notch", true);
  // TribePagePreloader.updateText("Waiting for login");
  // await AccountController.authPromise;
  TribePagePreloader.updateText("Connecting to Tribe");
  TribePagePreloader.updateSubtext("Please wait...");
  TribePagePreloader.hideReconnectButton();

  const snapName = DB.getSnapshot()?.name;
  if (snapName !== undefined) {
    name = snapName;
    TribeSocket.updateName(name);
  }

  //todo remove, only for dev
  const lstribename = window.localStorage.getItem("tribeName");
  if (lstribename) {
    name = lstribename;
    TribeSocket.updateName(lstribename);
  }

  setTimeout(() => {
    TribeSocket.connect();
  }, 500);
}

async function reset(): Promise<void> {
  $("#result #tribeResultBottom").addClass("hidden");
  TribeUserList.reset();
  TribeResults.reset();
  TribeChat.reset();
  TribeBars.hide();
  TribePageLobby.reset();
  TribeBars.reset();
  TribeButtons.reset();
}

export function joinRoom(roomId: string, fromBrowser = false): void {
  if (!/^[a-f0-9]{6}$/i.test(roomId)) {
    Notifications.add("Incorrect room code format", 0);
    return;
  }

  TribeSocket.out.room.join(roomId, fromBrowser).then((response) => {
    if (response.room) {
      TribeState.setRoom(response.room);
      updateState(response.room.state);
      TribePageLobby.init();
      TribePages.change("lobby");
      TribeSound.play("join");
      TribeChat.updateSuggestionData();
      // history.replaceState(null, "", `/tribe/${roomId}`);
    } else {
      TribePages.change("menu");
      history.replaceState("/tribe", "", "/tribe");
    }
  });
}

export function initRace(): void {
  let everyoneReady = true;
  const room = TribeState.getRoom();
  if (room?.users) {
    for (const user of Object.values(room.users)) {
      if (user.isLeader || user.isAfk) continue;
      if (!user.isReady) {
        everyoneReady = false;
      }
    }
  }
  if (everyoneReady) {
    TribeSocket.out.room.init();
  } else {
    TribeStartRacePopup.show();
  }
}

async function connect(): Promise<void> {
  const versionCheck = await TribeSocket.out.system.versionCheck(
    expectedVersion
  );

  if (versionCheck.status !== "ok") {
    TribeSocket.disconnect();
    TribePagePreloader.updateIcon("exclamation-triangle");
    TribePagePreloader.updateText(
      `Version mismatch.<br>Try refreshing or clearing cache.<br><br>Client version: ${expectedVersion}<br>Server version: ${versionCheck.version}`,
      true
    );
    TribePagePreloader.hideReconnectButton();
    TribePagePreloader.updateSubtext("");
    return;
  }

  UpdateConfig.setTimerStyle("mini", true);
  TribePageMenu.enableButtons();
  updateState(1);
  if (autoJoin) {
    TribePagePreloader.updateText(`Joining room ${autoJoin}`);
    TribePagePreloader.updateSubtext("Please wait...");
    setTimeout(() => {
      joinRoom(autoJoin as string);
    }, 500);
  } else {
    TribePages.change("menu");
  }
}

function checkIfEveryoneIsReady(): void {
  const room = TribeState.getRoom();
  if (!room) return;
  if (TribeState.getSelf()?.isLeader) {
    if (Object.keys(room.users).length <= 1) return;
    let everyoneReady = true;
    Object.keys(room.users).forEach((userId) => {
      if (room && (room.users[userId].isLeader || room.users[userId].isAfk)) {
        return;
      }
      if (room && !room.users[userId].isReady) {
        everyoneReady = false;
      }
    });
    if (everyoneReady) {
      Notifications.add("Everyone is ready", 1, undefined, "Tribe");
      TribeSound.play("chat_mention");
    }
  }
}

TribeSocket.in.system.connect(() => {
  connect();
});

$(".tribechangename").on("click", () => {
  const name = prompt("Name");
  if (name) {
    window.localStorage.setItem("tribeName", name); //todo remove, only for dev
    TribeSocket.out.user.setName(name, true);
  }
});

TribeSocket.in.user.updateName((e) => {
  name = e.name;
});

TribeSocket.in.system.disconnect((reason, details) => {
  updateState(-1);
  const roomId = TribeState.getRoom()?.id;
  if (!$(".pageTribe").hasClass("active")) {
    Notifications.add(
      `Disconnected: ${JSON.stringify(details)} (${reason})`,
      -1,
      undefined,
      "Tribe"
    );
  }
  TribeState.setRoom(undefined);
  TribePages.change("preloader");
  TribePagePreloader.updateIcon("times");
  TribePagePreloader.updateText(`Disconnected`);
  TribePagePreloader.updateSubtext(`${details?.["description"]} (${reason})`);
  TribePagePreloader.showReconnectButton();

  reset();
  if (roomId) {
    autoJoin = roomId;
  }
});

TribeSocket.in.system.connectFailed((err) => {
  updateState(-1);
  console.error(err);
  if (!$(".pageTribe").hasClass("active")) {
    Notifications.add("Connection failed", -1, undefined, "Tribe");
  }
  TribePages.change("preloader");
  TribePagePreloader.updateIcon("times");
  TribePagePreloader.updateText("Connection failed");
  TribePagePreloader.updateSubtext(err.message);
  TribePagePreloader.showReconnectButton();
  reset();
});

TribeSocket.in.system.connectError((err) => {
  updateState(-1);
  console.error(err);
  if (!$(".pageTribe").hasClass("active")) {
    Notifications.add("Connection error", -1, undefined, "Tribe");
  }
  TribePages.change("preloader");
  TribePagePreloader.updateIcon("times");
  TribePagePreloader.updateText(`Connection error`);
  TribePagePreloader.updateSubtext(err.message);
  TribePagePreloader.showReconnectButton();
  reset();
});

TribeSocket.in.system.reconnect((attempt) => {
  Notifications.add(
    `Reconnecting successful. (${attempt})`,
    1,
    undefined,
    "Tribe"
  );
});

TribeSocket.in.system.reconnectAttempt((attempt) => {
  Notifications.add(`Reconnecting... (${attempt})`, 0, undefined, "Tribe");
});

TribeSocket.in.system.notification((data) => {
  Notifications.add(data.message, data.level ?? 0, undefined, "Tribe");
});

TribeSocket.in.room.joined((data) => {
  TribeState.setRoom(data.room);
  updateState(data.room.state);
  TribePageLobby.init();
  TribePages.change("lobby");
  TribeSound.play("join");
  TribeChat.updateSuggestionData();
  // history.replaceState(null, "", `/tribe/${e.room.id}`);
});

TribeSocket.in.room.playerJoined((data) => {
  const room = TribeState.getRoom();
  if (room?.users) {
    room.users[data.user.id] = data.user;
    room.size = Object.keys(room.users).length;
    TribeUserList.update();
    TribeSound.play("join");
    TribeChat.updateSuggestionData();
    // TribeButtons.update("lobby")
  }
});

TribeSocket.in.room.playerLeft((data) => {
  const room = TribeState.getRoom();
  if (room?.users) {
    delete room.users[data.userId];
    room.size = Object.keys(room.users).length;
    TribeUserList.update();
    TribeSound.play("leave");
    TribeButtons.update();
    TribeBars.fadeUser(undefined, data.userId);
    TribeCarets.destroy(data.userId);
    TribeResults.fadeUser("result", data.userId);
    TribeResults.update("result", data.userId);
    checkIfEveryoneIsReady();
    TribeChat.updateSuggestionData();
    TribeChat.updateIsTyping();
  }
});

TribeSocket.in.room.left(() => {
  TribeState.setRoom(undefined);
  updateState(1);
  TribePageMenu.enableButtons();
  if (!$(".pageTribe").hasClass("active")) {
    navigate("/tribe");
  }
  TribeCarets.destroyAll();
  TribeSound.play("leave");
  TribePages.change("menu").then(() => {
    reset();
  });
  TribeChat.updateIsTyping();
  name = defaultName;
});

TribeSocket.in.room.visibilityChanged((data) => {
  const room = TribeState.getRoom();
  if (!room) return;
  room.isPrivate = data.isPrivate;
  TribePageLobby.updateVisibility();
});

TribeSocket.in.room.nameChanged((data) => {
  const room = TribeState.getRoom();
  if (!room) return;
  room.name = data.name;
  TribePageLobby.updateRoomName();
});

TribeSocket.in.room.userIsReady((data) => {
  const room = TribeState.getRoom();
  if (!room) return;
  room.users[data.userId].isReady = true;
  TribeUserList.update();
  TribeButtons.update();
  checkIfEveryoneIsReady();
});

TribeSocket.in.room.userAfkUpdate((data) => {
  const room = TribeState.getRoom();
  if (!room) return;
  room.users[data.userId].isAfk = data.isAfk;
  TribeUserList.update();
  TribeButtons.update();
});

TribeSocket.in.room.leaderChanged((data) => {
  const room = TribeState.getRoom();
  if (!room) return;
  for (const userId of Object.keys(room.users)) {
    delete room.users[userId].isLeader;
  }
  room.users[data.userId].isLeader = true;
  room.users[data.userId].isAfk = false;
  room.users[data.userId].isReady = false;
  TribeUserList.update();
  TribeButtons.update();
  TribePageLobby.updateVisibility();
  TribePageLobby.updateRoomName();
});

TribeSocket.in.room.chattingChanged((data) => {
  const room = TribeState.getRoom();
  if (!room) return;
  room.users[data.userId].isChatting = data.isChatting;
  TribeChat.updateIsTyping();
});

TribeSocket.in.room.chatMessage((data) => {
  data.message = data.message.trim();
  const regexString = `&#64;${escapeRegExp(escapeHTML(name))}${
    data.from?.isLeader ? "|ready|&#64;everyone" : ""
  }`;
  const nameregex = new RegExp(regexString, "i");
  if (!data.isSystem && data.from?.id != TribeSocket.getId()) {
    if (nameregex.test(data.message)) {
      if (ActivePage.get() !== "tribe" && ActivePage.get() !== "test") {
        Notifications.add(data.message, 0, 3, "Mention", "at", undefined, true); //allowing html because the message is already escaped on the server
      }
      TribeSound.play("chat_mention");
      data.message = data.message.replace(
        nameregex,
        "<span class='mention'>$&</span>"
      );
    } else {
      TribeSound.play("chat");
    }
  }

  TribeChat.appendMessage(data.isSystem, data.from?.id, data.message);
});

// socket.on("room_config_changed", (e) => {
TribeSocket.in.room.configChanged((data) => {
  const room = TribeState.getRoom();
  if (!room) return;
  room.config = data.config;
  // for (const user of Object.values(room.users)) {
  //   if (user.isReady) {
  //     user.isReady = false;
  //   }
  // }
  TribeConfig.apply(data.config);
  TribePageLobby.updateRoomConfig();
  TribeButtons.update();
  TribeConfig.setLoadingIndicator(false);
  TribeUserList.update();
});

// socket.on("room_init_race", (e) => {
TribeSocket.in.room.initRace((data) => {
  const room = TribeState.getRoom();
  updateState(11);
  if (TribeState.getSelf()?.isTyping) {
    TribeResults.init("result");
    TribeBars.init("test");
    TribeBars.show("test");
  } else {
    //TODO update lobby bars
    if (ActivePage.get() !== "tribe") {
      navigate("/tribe", {
        tribeOverride: true,
      });
    }
    TribeBars.init("tribe");
    TribeBars.show("tribe");
    return;
  }
  if (room) room.seed = data.seed;
  Random.setSeed(TribeState.getRoom()?.seed.toString() ?? "");
  navigate("/", {
    tribeOverride: true,
    force: true,
  });
  TribeDelta.reset();
  TribeDelta.showBar();
  TribeCountdown.show2();
  TribeSound.play("start");
  TribeCarets.init();
});

TribeSocket.in.room.stateChanged((data) => {
  updateState(data.state);
});

TribeSocket.in.room.countdown((data) => {
  TribeCountdown.update2(data.time.toString());
  if (data.time <= 3) TribeSound.play("cd");
});

TribeSocket.in.room.usersUpdate((data) => {
  const room = TribeState.getRoom();
  if (!room) return;

  let isChattingChanged = false;
  for (const [userId, user] of Object.entries(data)) {
    if (user.isTyping !== undefined) {
      room.users[userId].isTyping = user.isTyping;
    }
    if (user.isAfk !== undefined) room.users[userId].isAfk = user.isAfk;
    if (user.isReady !== undefined) room.users[userId].isReady = user.isReady;
    if (user.isChatting !== undefined) {
      isChattingChanged = true;
      room.users[userId].isChatting = user.isChatting;
    }
  }
  TribeUserList.update("lobby");
  TribeUserList.update("result");
  TribeButtons.update("lobby");
  if (isChattingChanged) {
    TribeChat.updateIsTyping();
  }
});

TribeSocket.in.room.raceStarted(() => {
  updateState(12);
  if (!TribeState.getSelf()?.isTyping) return;
  TribeSound.play("cd_go");
  TribeCountdown.hide2();
  setTimeout(() => {
    if (!TestState.isActive) {
      TimerEvent.dispatch("start");
    }
  }, 500);
});

// socket.on("room_progress_update", (e) => {
TribeSocket.in.room.progressUpdate((data) => {
  const room = TribeState.getRoom();
  if (!room) return;
  room.maxWpm = data.roomMaxWpm;
  room.maxRaw = data.roomMaxRaw;
  room.minWpm = data.roomMinWpm;
  room.minRaw = data.roomMinRaw;

  if (
    TribeState.getState() >= 10 &&
    TribeState.getState() <= 21 &&
    TestState.isActive === true
  ) {
    const wpmAndRaw = TestStats.calculateWpmAndRaw();
    const acc = Math.floor(TestStats.calculateAccuracy());
    let progress = 0;
    const inputLen = TestInput.input.current.length;
    if (Config.mode === "time") {
      progress = 100 - ((Time.get() + 1) / Config.time) * 100;
    } else {
      const currentWordLen = TestWords.words.getCurrent().length;
      const localWordProgress = Math.round((inputLen / currentWordLen) * 100);

      const globalWordProgress = Math.round(
        localWordProgress * (1 / TestWords.words.length)
      );

      let outof = TestWords.words.length;
      if (Config.mode === "words") {
        outof = Config.words;
      }

      const wordsProgress = Math.floor(
        (TestWords.words.currentIndex / outof) * 100
      );

      progress = wordsProgress + globalWordProgress;
    }

    if (room.config.isInfiniteTest) {
      progress = 0;
    }

    TribeSocket.out.room.progressUpdate({
      wpm: wpmAndRaw.wpm,
      raw: wpmAndRaw.raw,
      acc,
      progress,
      wordIndex: TestWords.words.currentIndex,
      letterIndex: inputLen - 1,
      afk: TestInput.currentKeypress.afk,
    });
  }

  TribeCarets.updateAndAnimate(data.users);

  for (const [userId, userProgress] of Object.entries(data.users)) {
    room.users[userId].progress = userProgress;
    if (userId == TribeSocket.getId()) {
      TribeDelta.update();
    }
    //todo only update one
    if (room.users[userId].isFinished === false) {
      TribeBars.update("test", userId);
      TribeBars.update("tribe", userId);
      TribeResults.updateBar("result", userId);
      TribeResults.updateWpmAndAcc(
        "result",
        userId,
        userProgress.wpm,
        userProgress.acc
      );
    }
  }
});

// socket.on("room_user_result", (e) => {
TribeSocket.in.room.userResult((data) => {
  const room = TribeState.getRoom();
  if (!room) return;
  room.users[data.userId].result = data.result;
  room.users[data.userId].isFinished = true;
  room.users[data.userId].isTyping = false;
  const resolve = data.result?.resolve;
  if (
    resolve === undefined ||
    resolve?.afk ||
    resolve?.repeated ||
    resolve?.valid === false ||
    resolve?.saved === false ||
    resolve?.failed === true
  ) {
    //todo only one

    let color = undefined;
    if (resolve?.failed === true) {
      color = "colorfulError" as keyof MonkeyTypes.ThemeColors;
    }

    if (color) TribeCarets.changeColor(data.userId, color);
    TribeBars.fadeUser("test", data.userId, color);
    TribeBars.fadeUser("tribe", data.userId, color);
    if (room.config.isInfiniteTest === false) {
      TribeResults.fadeUser("result", data.userId);
    }
    if (resolve?.afk) {
      TribeCarets.destroy(data.userId);
    }
  } else {
    TribeCarets.destroy(data.userId);
    if (room.config.mode !== "time") {
      TribeBars.completeBar("test", data.userId);
      TribeBars.completeBar("tribe", data.userId);
      TribeResults.updateBar("result", data.userId, 100);
    }
  }
  if (!TestState.isActive) {
    TribeCarets.destroyAll();
    TribeResults.update("result", data.userId);
    TribeUserList.update("result");
    setTimeout(async () => {
      if (data.everybodyCompleted) {
        await TribeChartController.drawAllCharts();
      } else {
        await TribeChartController.drawChart(data.userId);
      }
      if (TribeState.getState() >= 21) {
        TribeChartController.updateChartMaxValues();
      }
    }, 250);
  }
});

TribeSocket.in.room.finishTimerCountdown((data) => {
  if (TestState.isActive) {
    TribeCountdown.update(data.time.toString());
  } else {
    TribeResults.updateTimer(data.time.toString());
  }
});

TribeSocket.in.room.finishTimerOver(() => {
  TribeCountdown.hide();
  TribeResults.hideTimer();
  if (TestState.isActive) {
    TimerEvent.dispatch("fail", "out of time");
  }
});

TribeSocket.in.room.destroyTest((data) => {
  if (TestState.isActive) {
    if (data.reason === "afk") {
      TimerEvent.dispatch("fail", "afk");
    }
  }
});

TribeSocket.in.room.readyTimerCountdown((data) => {
  if (TestState.isActive) {
    TribeCountdown.update(data.time.toString());
  } else {
    TribeResults.updateTimer(data.time.toString());
  }
});

TribeSocket.in.room.readyTimerOver(() => {
  TribeCountdown.hide();
  TribeResults.hideTimer();
  if (TestState.isActive) {
    TimerEvent.dispatch("fail", "out of time");
  }
});

TribeSocket.in.room.backToLobby(() => {
  navigate("/tribe");
});

TribeSocket.in.room.finalPositions((data) => {
  const room = TribeState.getRoom();
  if (!room) return;
  TribeResults.updatePositions("result", data.sorted, true);
  TribeResults.updateMiniCrowns("result", data.miniCrowns);
  for (const user of Object.values(data.sorted)) {
    room.users[user.id].points = user.newPoints;
  }
  TribeUserList.update();

  let isGlowing = false;
  if (
    data.miniCrowns.wpm.includes(data.sorted[0]?.id) &&
    data.miniCrowns.acc.includes(data.sorted[0]?.id) &&
    data.miniCrowns.raw.includes(data.sorted[0]?.id) &&
    data.miniCrowns.consistency.includes(data.sorted[0]?.id)
  ) {
    isGlowing = true;
  }

  if (data.sorted[0]?.id) {
    TribeResults.showCrown("result", data.sorted[0]?.id, isGlowing);
  }

  if (data?.sorted[0]?.id === TribeSocket.getId()) {
    TribeSound.play("finish_win");
    if (isGlowing) {
      TribeSound.play("glow");
    }
  } else {
    TribeSound.play("finish");
  }
});

$(`.pageTribe .tribePage.lobby .lobbyButtons .startTestButton,
  .pageTest #tribeResultBottom .buttons .startTestButton`).on("click", (_e) => {
  initRace();
});

$(".pageTribe .tribePage.preloader .reconnectButton").on("click", () => {
  TribePagePreloader.hideReconnectButton();
  init();
});

window.addEventListener("beforeunload", () => {
  if (TribeState.getState() > 0) {
    TribeSocket.disconnect();
  }
});
