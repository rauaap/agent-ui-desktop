/**
 * Session-name suggestions like `quiet-harbor`, so creating a session is a
 * click rather than a bout of typing. Ported from the Android client's
 * NameGenerator plus its res/raw word lists, which are inlined here — a few KB
 * of short strings, and inlining keeps the client to zero fetches at startup.
 *
 * Names are not unique and are not meant to be: sessions are identified by id,
 * duplicates are harmless, and checking would put a round trip in front of the
 * very interaction this exists to shorten.
 */

const ADJECTIVES = `
  able above absolute accepted accurate ace active actual adapted adapting
  adequate adjusted advanced alert alive allowed allowing amazed amazing
  ample amused amusing apparent apt arriving artistic assured assuring
  awaited awake aware balanced becoming beloved better big blessed bold boss
  brave brief bright bursting busy calm capable capital careful caring
  casual causal central certain champion charmed charming cheerful chief
  choice civil classic clean clear clever climbing close closing coherent
  comic communal complete composed concise concrete content cool correct
  cosmic crack creative credible crisp crucial cuddly cunning curious
  current cute daring darling dashing dear decent deciding deep definite
  delicate desired destined devoted direct discrete distinct diverse divine
  dominant driven driving dynamic eager easy electric elegant emerging
  eminent enabled enabling endless engaged engaging enhanced enjoyed
  enormous enough epic equal equipped eternal ethical evident evolved
  evolving exact excited exciting exotic expert factual fair faithful famous
  fancy fast feasible fine finer firm first fit fitting fleet flexible
  flowing fluent flying fond frank free fresh full fun funky funny game
  generous gentle genuine giving glad glorious glowing golden good gorgeous
  grand grateful great growing grown guided guiding handy happy hardy
  harmless healthy helped helpful helping heroic hip holy honest hopeful hot
  huge humane humble humorous ideal immense immortal immune improved in
  included infinite informed innocent inspired integral intense intent
  internal intimate inviting joint just keen key kind knowing known large
  lasting leading learning legal legible lenient liberal light liked
  literate live living logical loved loving loyal lucky magical magnetic
  main major many massive master mature maximum measured meet merry mighty
  mint model modern modest moral more moved moving musical mutual national
  native natural nearby neat needed neutral new next nice noble normal
  notable noted novel obliging on one open optimal optimum organic oriented
  outgoing patient peaceful perfect pet picked pleasant pleased pleasing
  poetic polished polite popular positive possible powerful precious precise
  premium prepared present pretty primary prime pro probable profound
  promoted prompt proper proud proven pumped pure quality quick quiet rapid
  rare rational ready real refined regular related relative relaxed relaxing
  relevant relieved renewed renewing resolved rested rich right robust
  romantic ruling sacred safe saved saving secure select selected sensible
  set settled settling sharing sharp shining simple sincere singular skilled
  smart smashing smiling smooth social solid sought sound special splendid
  square stable star steady sterling still stirred stirring striking strong
  stunning subtle suitable suited summary sunny super superb supreme sure
  sweeping sweet talented teaching tender thankful thorough tidy tight
  together tolerant top topical tops touched touching tough true trusted
  trusting trusty ultimate unbiased uncommon unified unique united up
  upright upward usable useful valid valued vast verified viable vital vocal
  wanted warm wealthy welcome welcomed well whole willing winning wired wise
  witty wondrous workable working worthy
`.trim().split(/\s+/);

const NOUNS = `
  afternoon alert blame blink boot branch breather buffer build callback
  checkin checkout checkpoint clone commit compile crash crunch cutover
  cycle dawn debrief demo deploy diff dusk epoch escalation evening flash
  flush fork freeze handoff heartbeat hotfix hour incident init instant
  interval iteration job kickoff lapse launch lint lull merge midday
  midnight milestone minute moment morning night noon outage overtime page
  patch pause ping poll postmortem publish pull pulse push rebase reboot
  refresh release restart retro revert review rollback rollout run runway
  second session shift ship showcase slot snapshot span spawn sprint squash
  standup stash stretch sunrise sunset sync tag tick timeout timestamp
  triage trigger twilight watch webhook window
`.trim().split(/\s+/);

const pick = (words) => words[Math.floor(Math.random() * words.length)];

/** e.g. "quiet-harbor". */
export const suggestName = () => `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
