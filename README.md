# Salah Travel — Passenger Agent Server

## Riaz ke liye (Roman Urdu)

**Ye server kya hai?**
App main jo agent passenger se baat karega, us ki "akal" is server par
chalegi. AI key sirf is server par rahegi — app main key kabhi nahi hogi,
is liye koi customer key nahi nikal sakta.

**Server kya karta hai?**
- `/ask` — passenger ka sawal + ticket lines le kar AI se jawab mangta hai.
  Jawab sirf ticket lines se hota hai, koi fare/time invent nahi hota.
- `/speak` — jawab ki smooth awaz (MP3) banata hai, ChatGPT jaisi.
- `/hear` — passenger ki awaz ko text main badalta hai (server par, is
  liye phone ke recognizer ki kamzori se farq nahi parta).
- Koi passenger data save nahi hota — har request ke baad bhool jata hai.

**Aap ke haathon wale kaam (jab deploy ka waqt aaye):**
1. Hosting account banayein (Railway ya Fly.io — taqreeban $2-7/month).
2. Is folder ka code wahan deploy karein.
3. Hosting dashboard main `OPENAI_API_KEY` set karein — key aap ke
   OpenAI account se banegi, **kabhi chat main mat bhejna**.
4. Server ka URL app ke Admin main daalein (Agent card — agle stage main
   banega), phir customers ka agent us URL se baat karega.

**Kharcha:** server $2-7/month + AI ka per-use kharcha (sawal/awaz ke
hisab se, bill OpenAI account main nazar aayega).

## Developer notes (English)

- Zero dependencies, plain Node.js 18+. `node server.js` (env: `PORT`,
  `OPENAI_API_KEY`, `OPENAI_MODEL` default `gpt-4o-mini`, `OPENAI_VOICE`
  default `nova`).
- Rate limit: 30 req/min per IP (in-memory). Caps: `/ask` question 1000
  chars, 40 ticket lines; `/speak` text 2000 chars; `/hear` body 10 MB.
- Error contract (never leaks provider bodies or keys): `ai_key_missing`
  (503, no key configured), `ai_key_invalid` (bad key), `ai_busy` (rate
  limited upstream), `ai_failed`, `too_many`, `bad_json`, `bad_question`,
  `bad_tickets`, `bad_text`, `bad_body`, `too_big`, `not_found`.
- Privacy: the app sends only the question + ticket lines. The server
  never receives passenger names, numbers or documents, never writes
  requests to disk, and logs only method + path + status.
- Without a key the server still boots; `/health` answers, AI endpoints
  answer `ai_key_missing` — so deploy health checks pass before the key
  is set.
