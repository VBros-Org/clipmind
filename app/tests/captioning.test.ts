import test from "node:test";
import assert from "node:assert/strict";

import {
  captionClip,
  findCaptionSanityError,
  parseMindCaptionReply,
  type CaptionedClip,
  type CaptioningClip,
  type CaptioningStore,
  type CaptioningWrite,
  type PostCopyVariants,
} from "../lib/captioning";

test("parseMindCaptionReply parses HTML-wrapped JSON objects with all platform keys", () => {
  const variants = {
    youtube: "Copper Hoe Saves The Run",
    tiktok: "copper hoe save went silly #Minecraft #ClutchSave",
    instagram: "copper hoe save went silly\n#Minecraft #ClutchSave",
  };

  assert.deepEqual(
    parseMindCaptionReply(`<section>${JSON.stringify(variants)}</section>`),
    variants,
  );
});

test("parseMindCaptionReply rejects missing or blank platform keys", () => {
  assert.equal(
    parseMindCaptionReply('{"youtube":"title","tiktok":"caption"}'),
    null,
  );
  assert.equal(
    parseMindCaptionReply(
      '{"youtube":"title","tiktok":"caption","instagram":"   "}',
    ),
    null,
  );
});

test("captionClip rejects dash characters and retries with a corrective note", async () => {
  const store = new MemoryCaptioningStore(memoryClip("clip-1"));
  const cleanVariants = variants({
    tiktok: "bro the copper hoe actually saved me #Minecraft #ClutchSave",
  });
  const mindsClient = fakeMindsClient([
    JSON.stringify(
      variants({
        tiktok: "bro the copper hoe actually saved me \u2014 what #Minecraft",
      }),
    ),
    JSON.stringify(cleanVariants),
  ]);

  const result = await captionClip("clip-1", {
    store,
    mindsClient,
  });

  assert.equal(result.status, "captioned");
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.variants, cleanVariants);
  assert.equal(store.writeCalls.length, 1);
  assert.equal(store.clip.postCopy, cleanVariants.tiktok);
  assert.deepEqual(store.clip.postCopyVariants, cleanVariants);
  assert.equal(mindsClient.calls[0]?.alias, "clipmind-caption-clip1-1");
  assert.equal(mindsClient.calls[1]?.alias, "clipmind-caption-clip1-2");
  assert.match(
    mindsClient.calls[1]?.messageText ?? "",
    /Correction for this retry:/,
  );
  assert.match(
    mindsClient.calls[1]?.messageText ?? "",
    /em dashes or en dashes/,
  );
});

test("captionClip rejects near-identical TikTok and Instagram variants and retries", async () => {
  const store = new MemoryCaptioningStore(memoryClip("clip-similar"));
  const cleanVariants = variants({
    instagram:
      "bro the copper hoe actually saved me\nlast second save had no business working.\n#Minecraft #ClutchSave",
  });
  const mindsClient = fakeMindsClient([
    JSON.stringify(
      variants({
        tiktok:
          "okay so this is the moment everything went wrong and the copper hoe saved me #Minecraft #ClutchSave",
        instagram:
          "have you ever seen a copper hoe save the run? okay so this is the moment everything went wrong and the copper hoe saved me #Minecraft #MinecraftFail",
      }),
    ),
    JSON.stringify(cleanVariants),
  ]);

  const result = await captionClip("clip-similar", {
    store,
    mindsClient,
  });

  assert.equal(result.status, "captioned");
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.variants, cleanVariants);
  assert.equal(store.writeCalls.length, 1);
  assert.equal(store.clip.postCopy, cleanVariants.tiktok);
  assert.deepEqual(store.clip.postCopyVariants, cleanVariants);
  assert.match(
    mindsClient.calls[1]?.messageText ?? "",
    /near-identical/,
  );
  assert.match(
    mindsClient.calls[1]?.messageText ?? "",
    /Instagram must have a first-line hook/,
  );
});

test("captionClip returns FAILED after missing keys and writes nothing", async () => {
  const store = new MemoryCaptioningStore(memoryClip("clip-missing"));
  const mindsClient = fakeMindsClient([
    '{"youtube":"title","tiktok":"caption"}',
    '{"youtube":"title","instagram":"caption"}',
  ]);

  const result = await captionClip("clip-missing", {
    store,
    mindsClient,
  });

  assert.deepEqual(result, {
    status: "failed",
    clipId: "clip-missing",
    creatorId: "creator-1",
    videoId: "video-1",
    mindId: "mind-1",
    reason: "invalid_mind_reply",
    attempts: 2,
    replies: [
      '{"youtube":"title","tiktok":"caption"}',
      '{"youtube":"title","instagram":"caption"}',
    ],
    errors: [
      "Mind caption reply did not include a JSON object with non-empty youtube, tiktok, and instagram strings.",
      "Mind caption reply did not include a JSON object with non-empty youtube, tiktok, and instagram strings.",
    ],
  });
  assert.equal(store.writeCalls.length, 0);
  assert.equal(store.clip.postCopy, null);
  assert.equal(store.clip.postCopyVariants, null);
});

test("captionClip asserts status and rank fields are not changed by the write", async () => {
  const store = new MemoryCaptioningStore(memoryClip("clip-control"), {
    mutateStatusOnWrite: "accepted",
  });
  const mindsClient = fakeMindsClient([JSON.stringify(variants())]);

  await assert.rejects(
    () =>
      captionClip("clip-control", {
        store,
        mindsClient,
      }),
    /Caption changed Clip.status/,
  );
  assert.equal(store.writeCalls.length, 1);

  const rankStore = new MemoryCaptioningStore(memoryClip("clip-rank"), {
    mutateRankOnWrite: 2,
  });
  const rankMindsClient = fakeMindsClient([JSON.stringify(variants())]);

  await assert.rejects(
    () =>
      captionClip("clip-rank", {
        store: rankStore,
        mindsClient: rankMindsClient,
      }),
    /Caption changed Clip.mindRank/,
  );
  assert.equal(rankStore.writeCalls.length, 1);
});

test("captionClip returns FAILED after unparseable replies and writes nothing", async () => {
  const store = new MemoryCaptioningStore(memoryClip("clip-fail"));
  const mindsClient = fakeMindsClient([
    "I would make this a copper hoe joke.",
    "<p>Still no JSON object.</p>",
  ]);

  const result = await captionClip("clip-fail", {
    store,
    mindsClient,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "invalid_mind_reply");
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.replies, [
    "I would make this a copper hoe joke.",
    "<p>Still no JSON object.</p>",
  ]);
  assert.equal(store.writeCalls.length, 0);
  assert.equal(store.clip.postCopy, null);
  assert.equal(store.clip.postCopyVariants, null);
});

test("findCaptionSanityError catches en dash and em dash characters", () => {
  assert.match(
    findCaptionSanityError(
      variants({
        youtube: "Copper hoe \u2013 save",
      }),
    ) ?? "",
    /youtube contains/,
  );
  assert.match(
    findCaptionSanityError(
      variants({
        instagram: "Copper hoe \u2014 save",
      }),
    ) ?? "",
    /instagram contains/,
  );
});

type MemoryClip = CaptioningClip & {
  postCopy: string | null;
  postCopyVariants: PostCopyVariants | null;
};

type MemoryCaptioningStoreOptions = {
  mutateStatusOnWrite?: CaptioningClip["status"];
  mutateRankOnWrite?: number | null;
};

class MemoryCaptioningStore implements CaptioningStore {
  readonly writeCalls: CaptioningWrite[] = [];

  constructor(
    readonly clip: MemoryClip,
    private readonly options: MemoryCaptioningStoreOptions = {},
    private readonly mindId: string | null = "mind-1",
  ) {}

  async loadCaptioningRequest(clipId: string) {
    if (clipId !== this.clip.id) {
      return {
        clip: null,
        creatorMindId: null,
      };
    }

    return {
      clip: cloneClip(this.clip),
      creatorMindId: this.mindId,
    };
  }

  async writePostCopy(args: CaptioningWrite): Promise<CaptionedClip> {
    this.writeCalls.push({
      clip: cloneClip(args.clip),
      variants: { ...args.variants },
    });

    this.clip.postCopy = args.variants.tiktok;
    this.clip.postCopyVariants = { ...args.variants };

    if (this.options.mutateStatusOnWrite) {
      this.clip.status = this.options.mutateStatusOnWrite;
    }
    if (this.options.mutateRankOnWrite !== undefined) {
      this.clip.mindRank = this.options.mutateRankOnWrite;
    }

    return {
      clipId: this.clip.id,
      creatorId: this.clip.creatorId,
      videoId: this.clip.videoId,
      status: this.clip.status,
      mindRank: this.clip.mindRank,
      mindRankReason: this.clip.mindRankReason,
      postCopy: this.clip.postCopy,
      postCopyVariants: this.clip.postCopyVariants,
    };
  }
}

function fakeMindsClient(replies: string[]) {
  const calls: {
    mindId: string;
    alias: string;
    messageText: string;
    action: string;
  }[] = [];

  return {
    calls,
    async sendMessageAndWaitForReply(args: {
      mindId: string;
      alias: string;
      messageText: string;
      action: string;
    }) {
      calls.push(args);
      const reply = replies.shift();
      if (reply === undefined) {
        throw new Error("No fake Mind reply queued.");
      }
      return reply;
    },
  };
}

function memoryClip(id: string): MemoryClip {
  return {
    id,
    creatorId: "creator-1",
    videoId: "video-1",
    startMs: 1_000,
    endMs: 13_000,
    transcript: "No way the copper hoe saved me at the last second",
    status: "candidate",
    mindRank: 1,
    mindRankReason: "creator likes chaotic saves",
    videoContext: 'clipServiceReasons={"hook":"last second save"}',
    postCopy: null,
    postCopyVariants: null,
  };
}

function cloneClip(clip: CaptioningClip): CaptioningClip {
  return {
    ...clip,
  };
}

function variants(
  overrides: Partial<PostCopyVariants> = {},
): PostCopyVariants {
  return {
    youtube: "Copper Hoe Saves The Run",
    tiktok: "bro the copper hoe actually saved me #Minecraft #ClutchSave",
    instagram:
      "bro the copper hoe actually saved me\nthat last second save should not be real.\n#Minecraft #ClutchSave",
    ...overrides,
  };
}
