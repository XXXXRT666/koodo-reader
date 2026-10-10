const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const plugin = require("../src/assets/plugins/aliyun-custom-voice-tts-plugin.json");
const catalog = [
  ["cosyvoice-v3.5-plus", "ve_03_02", "cosyvoice-v3.5-plus-bailian-c89f64152a2f44c4b5127766ab4cc10c"],
  ["cosyvoice-v3.5-plus", "ve_04_01", "cosyvoice-v3.5-plus-bailian-968248e6a5614af3a77503c96e744ef1"],
  ["qwen-audio-3.0-tts-plus", "ve_02", "qwen-audio-3.0-tts-plus-bailian-692b6df2b2664d5d827a4b67d4950c84"],
  ["qwen-audio-3.0-tts-plus", "ve_03_02", "qwen-audio-3.0-tts-plus-bailian-f88a8fc60f6b4fb589a86487e99d1706"],
  ["qwen-audio-3.0-tts-plus", "ve_04_01", "qwen-audio-3.0-tts-plus-bailian-187e9642335d446a97d02313ee998cce"],
];
const config = { ...plugin.config, apiKey: "test-api-key", debug: "no" };
const listResponse = (voices) => ({ data: { output: { voice_list: voices } } });
const listFixture = catalog.map(([model, , voice_id]) => ({ target_model: model, voice_id, status: "OK" }));
const audioUrl = "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav?Signature=fake%2Fvalue%3D";
const synthesisResponse = { data: { request_id: "test-request", output: { finish_reason: "stop", audio: { url: audioUrl } } } };
const audioData = Buffer.from("test audio bytes");
const plain = (value) => JSON.parse(JSON.stringify(value));

function runtime(axios) {
  const delays = [];
  const context = {
    global: {}, Buffer, console,
    require: (name) => name === "axios" ? axios : require(name),
    setTimeout: (callback, ms) => { delays.push(ms); queueMicrotask(callback); },
  };
  vm.runInNewContext(plugin.script, context, { filename: "aliyun-custom-voice-tts-plugin.js" });
  return { ...context.global, delays };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aliyun-voice-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("bundled plugin keeps its identifier, refreshes voices and has a valid script hash", () => {
  assert.equal(plugin.identifier, "qwen-custom-voice-tts-plugin");
  assert.deepEqual(plugin.voiceList, []);
  assert.equal(crypto.createHash("sha256").update(plugin.script).digest("hex"), plugin.scriptSHA256);
  assert.doesNotMatch(plugin.script, /qwen-voice-enrollment|multimodal-generation\/generation|qwen3-tts-vc-/);
});

test("paginated discovery returns friendly labels in model order, with original IDs for selection", async () => {
  const rows = [...listFixture].reverse().concat({ voice_id: "unmapped-voice", status: "OK" });
  const calls = [];
  const api = runtime({ post: async (url, body, options) => {
    calls.push(plain({ url, body, options }));
    const start = body.input.page_index * body.input.page_size;
    return listResponse(rows.slice(start, start + body.input.page_size));
  } });
  const voices = plain(await api.getTTSVoice({ ...config, pageSize: "2", baseUrl: config.baseUrl + "/" }));
  assert.deepEqual(voices.map((voice) => voice.displayName), catalog.map(([model, alias]) => `${model} ${alias}`));
  assert.deepEqual(voices.map((voice) => voice.name), catalog.map(([, , id]) => id));
  assert.deepEqual(calls.map((call) => call.body.input.page_index), [0, 1, 2, 3]);
  for (const call of calls) {
    assert.equal(call.url, config.baseUrl + "/services/audio/tts/customization");
    assert.equal(call.body.model, "voice-enrollment");
    assert.equal(call.body.input.action, "list_voice");
    assert.equal(call.options.headers.Authorization, "Bearer test-api-key");
    assert.equal(call.options.timeout, 90000);
  }
  voices.forEach((voice, index) => {
    assert.equal(voice.config.model, catalog[index][0]);
    assert.equal(voice.config.voiceName, catalog[index][2]);
    assert.equal(voice.plugin, plugin.identifier);
    assert.equal(voice.locale, "zh-CN");
    assert.ok(!voice.displayName.includes("bailian-"));
  });
});

test("deleted, non-ready and unmapped voices are not shown", async () => {
  const rows = [listFixture[0], { ...listFixture[1], status: "DEPLOYING" }, { ...listFixture[2], status: "UNDEPLOYED" }, { voice_id: "unmapped", status: "OK" }];
  const api = runtime({ post: async () => listResponse(rows) });
  assert.deepEqual(plain(await api.getTTSVoice(config)).map((voice) => voice.name), [catalog[0][2]]);
});

test("missing keys, malformed responses and empty named-voice lists fail explicitly", async () => {
  const api = runtime({ post: async () => { throw new Error("must not send a request"); } });
  await assert.rejects(api.getTTSVoice({ ...config, apiKey: "" }), /Missing DashScope apiKey/);
  await assert.rejects(runtime({ post: async () => ({ data: {} }) }).getTTSVoice(config), /Invalid Aliyun voice list/);
  await assert.rejects(runtime({ post: async () => listResponse([]) }).getTTSVoice(config), /No configured Aliyun voices/);
});

test("all five voices use SpeechSynthesizer and Reader speed deltas become API rates", async (t) => {
  const directory = temporaryDirectory(t);
  for (const [model, , voiceId] of catalog) {
    for (const [speed, rate] of [[0, 1.0], [-10, 0.9], [-20, 0.8], [-90, 0.5], [300, 2.0]]) {
      const api = runtime({
        post: async (url, body, options) => {
          assert.equal(url, config.baseUrl + "/services/audio/tts/SpeechSynthesizer");
          assert.deepEqual(plain(body), { model, input: { text: "reader sample", voice: voiceId, format: "wav", sample_rate: 24000, volume: 50, pitch: 1.0, rate, language_hints: ["zh"], seed: 0 } });
          assert.equal(options.headers.Authorization, "Bearer test-api-key");
          return synthesisResponse;
        },
        get: async (url, options) => {
          assert.equal(url, audioUrl.replace("http:", "https:"));
          assert.deepEqual(plain(options), { responseType: "arraybuffer", timeout: 90000 });
          return { data: audioData };
        },
      });
      const output = await api.getAudioPath("reader sample", speed, directory, { ...config, model, voiceName: voiceId });
      assert.equal(path.dirname(output), path.join(directory, "tts"));
      assert.equal(path.extname(output), ".wav");
      assert.deepEqual(fs.readFileSync(output), audioData);
    }
  }
});

test("model and voice cannot be mismatched, and incomplete synthesis is not downloaded", async (t) => {
  const directory = temporaryDirectory(t);
  const voiceConfig = { ...config, model: catalog[0][0], voiceName: catalog[0][2] };
  let calls = 0;
  const api = runtime({ post: async () => { calls++; return synthesisResponse; } });
  await assert.rejects(api.getAudioPath("sample", 0, directory, { ...voiceConfig, model: catalog[2][0] }), /mismatched/);
  assert.equal(calls, 0);
  for (const output of [{ finish_reason: "null", audio: { url: audioUrl } }, { finish_reason: "stop", audio: {} }]) {
    const incomplete = runtime({ post: async () => ({ data: { output } }), get: async () => assert.fail("must not download") });
    await assert.rejects(incomplete.getAudioPath("sample", 0, directory, voiceConfig), /No complete audio URL/);
  }
});

test("transient POST failures are retried, authentication failures are not", async () => {
  let attempts = 0;
  const api = runtime({ post: async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    return listResponse(listFixture);
  } });
  assert.equal((await api.getTTSVoice(config)).length, 5);
  assert.equal(attempts, 3);
  assert.deepEqual(api.delays, [500, 1000]);
  attempts = 0;
  const denied = runtime({ post: async () => { attempts++; throw Object.assign(new Error("denied"), { response: { status: 401 } }); } });
  await assert.rejects(denied.getTTSVoice(config), /denied/);
  assert.equal(attempts, 1);
});

test("audio download retry does not resynthesize or forward API credentials", async (t) => {
  let syntheses = 0;
  let downloads = 0;
  const api = runtime({
    post: async () => { syntheses++; return synthesisResponse; },
    get: async (_, options) => {
      assert.equal(options.headers, undefined);
      downloads++;
      if (downloads === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      return { data: audioData };
    },
  });
  await api.getAudioPath("sample", 0, temporaryDirectory(t), { ...config, model: catalog[2][0], voiceName: catalog[2][2] });
  assert.equal(syntheses, 1);
  assert.equal(downloads, 2);
  assert.deepEqual(api.delays, [500]);
});
