import { Hono } from 'https://deno.land/x/hono@v3.12.0/mod.ts'
import { cors } from "https://deno.land/x/hono@v3.12.0/middleware.ts"
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.43/deno-dom-wasm.ts";

const kv = await Deno.openKv();

const app = new Hono()

app.use(
  '/bskyunroll',
  cors({
    origin: '*'
  })
)


/**
 * Retrieve and parse HTML from a given URL
 * @param {string} url 
 * @returns {Promise<HTMLDocument | null>}
 */
async function fetchHTML(url) {
  try {
    const res = await fetch(url);
    const html = await res.text();
    const parser = new DOMParser();
    return parser.parseFromString(html, "text/html");
  } catch {
    return null
  }
}

/**
 * "Safely" parses JSON from a given string
 * @param {string} str 
 * @returns {Object}
 */
function safeJSONParse(str) {
  try {
    const jsonValue = JSON.parse(str);
    return jsonValue;
  } catch {
    return undefined;
  }
};

/**
 * Fetch JSON from a given URL
 * @param {string} url 
 * @returns {Promise<Object>}
 */
async function fetchJSON(url) {
  const res = await fetch(url);
  const txt = await res.text();
  return safeJSONParse(txt);
}

/**
 * Retrieve Blueksy did from a given post HTML
 * @param {HTMLDocument} postDoc 
 * @returns {string | null}
 */
function didFromPost(postDoc) {
	if (!postDoc) return null;

	const didElement = postDoc.querySelector("p#bsky_did");
	if (!didElement) return null;

	return didElement.innerText.trim();
}

/**
 * Retrieve image embeds from a given post embeds array
 * @param {[]} embeds 
 * @param {string} didPlc 
 * @returns {string[]}
 */
function extractEmbeds(embeds, didPlc) {
  if (embeds && Object.keys(embeds).includes("$type")) {
    if (embeds["$type"] === "app.bsky.embed.images") {
      const imgs = [];
      for (const image of embeds.images) {
        const mime = image.image.mimeType.split("/").pop()
        const link = image.image.ref["$link"]
        imgs.push(`https://cdn.bsky.app/img/feed_thumbnail/plain/${didPlc}/${link}@${mime}`)
      }
      return imgs;
    }
  }
  return [];
}

/**
 * Extract links from a given posts facets
 * @param {[]} facets 
 * @returns {{ uri: string; start: int; end: int; }[]}
 */
function extractFacets(facets) {
  const fcts = [];
  if (facets) {
    for (const facet of facets) {
      const features = facet.features.filter(d => d[ "$type" ] === "app.bsky.richtext.facet#link")
      if (features.length > 0) {
        for (const feature of features) {
          fcts.push({
            uri: feature.uri,
            start: facet.index.byteStart,
            end: facet.index.byteEnd
          })          
        }
      }
    }
  }
  return(fcts)
}
 
/**
 * 
 * @param {Object} thread 
 * @param {string} authorDid 
 * @returns {{ uri: string; text: string; embed: []; facets: []}[]}
 */
function extractReplies(thread, authorDid) {
  const replies = [];
  const cid = thread.post.cid

  function traverseReplies(replyArray, pcid) {
    if (!Array.isArray(replyArray)) {
      return;
    }
    for (const reply of replyArray) {

      if (reply.post.author.did === authorDid) {
        if (reply.post.record.reply.root.cid == cid) {
          if (reply.post.record.reply.parent.cid == pcid) {
            replies.push({
              uri: reply.post.uri,
              text: reply.post.record.text,
              embed: extractEmbeds(reply.post.record.embed, authorDid),
              facets: extractFacets(reply.post.record.facets)
            });
            if (reply.replies && reply.replies.length > 0) {
              traverseReplies(reply.replies, reply.post.cid);
            }
          }
        }
      }
    }
  }

  traverseReplies(thread.replies, thread.post.cid);
  return replies;
}

/**
 * Fetch a Bluesky author thread as JSON
 * @param {string} postURL 
 * @returns { Promise <{ author: { Object }, thread: { uri: string; text: string; embed: []; facets: []}[] }> | null}
 */
async function fetchThread(postURL) {
  const entry = await kv.get([postURL]);
  if (entry.value !== null) {
    return entry.value
  }

  // fetch the HTML
  const postDoc = await fetchHTML(postURL)
  if (!postDoc) {
    return {
      message: "Error: Invalid URL"
    }
  }

  // extract did:plc
  const did = didFromPost(postDoc)

  // get the thread post id
  const postThreadTop = postURL.split("/").pop();

  // fetch the thread
  const threadURL = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=at://${did}/app.bsky.feed.post/${postThreadTop}`
  const thread = await fetchJSON(threadURL)

  // identify the main author's thread replies and make an array of them
  const replies = [{
    uri: thread.thread.post.uri,
    text: thread.thread.post.record.text,
    embed: extractEmbeds(thread.thread.post.record.embed, thread.thread.post.author.did),
    facets: extractFacets(thread.thread.post.record.facets)
  } ].concat(
    extractReplies(thread.thread, thread.thread.post.author.did)
  );

  // add author metadata to the thread info
  const out = {
    message: "success",
    author: thread.thread.post.author,
    thread: replies
  }

  const result = await kv.set([postURL], out);

  return (out)
}

app.get('/bskyunroll', async (c) => {
  // a given Bluesky post URL
  const postURL = c.req.query('postURL')
  
  console.log(JSON.stringify({
    ts: new Date(),
    postURL: postURL || ""
  }))

  const out = await fetchThread(postURL)
  
  if (out.message !== "success") {
    c.status(400)
  }

  c.header()

  return c.json(out)
})

Deno.serve(app.fetch);
