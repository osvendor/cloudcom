import { randomInt } from 'node:crypto';

// A deliberately bounded set of ordinary words keeps generated values readable
// and within the customer's 12-character cap. This is not a general-purpose
// passphrase strength policy; callers must still honor a provider's requirements.
export const CREDENTIAL_PASSWORD_WORDS: readonly string[] = Object.freeze([
  'ace', 'act', 'add', 'age', 'aid', 'aim', 'air', 'ant', 'ape', 'arc', 'ark', 'arm',
  'art', 'ash', 'aunt', 'axis', 'baby', 'back', 'bag', 'bake', 'ball', 'band', 'bank',
  'bark', 'barn', 'base', 'bash', 'bath', 'bay', 'bead', 'beak', 'beam', 'bean', 'bear',
  'beat', 'bed', 'bee', 'bell', 'belt', 'bend', 'best', 'bike', 'bill', 'bird', 'bite',
  'blue', 'boat', 'body', 'bold', 'bolt', 'bond', 'bone', 'book', 'boot', 'bowl', 'box',
  'brim', 'buck', 'bulb', 'bump', 'bun', 'bush', 'bus', 'busy', 'buzz', 'cafe', 'cage',
  'cake', 'calf', 'calm', 'camp', 'can', 'cape', 'cap', 'card', 'care', 'cart', 'case',
  'cash', 'cat', 'cave', 'chef', 'chip', 'city', 'clam', 'clap', 'clay', 'clip', 'club',
  'coal', 'coat', 'code', 'coin', 'cold', 'colt', 'comb', 'cook', 'cool', 'cope', 'copy',
  'cord', 'core', 'cork', 'corn', 'cost', 'cove', 'cow', 'crab', 'crew', 'crop', 'crow',
  'cube', 'cub', 'cup', 'curl', 'cute', 'damp', 'dare', 'dark', 'dash', 'data', 'date',
  'dawn', 'day', 'deal', 'dear', 'deck', 'deep', 'deer', 'den', 'desk', 'dew', 'dial',
  'dice', 'diet', 'dig', 'dime', 'dine', 'dip', 'dish', 'disk', 'dock', 'dog', 'doll',
  'dome', 'done', 'door', 'dot', 'dove', 'draw', 'drop', 'drum', 'dry', 'duck', 'dune',
  'dusk', 'dust', 'each', 'ear', 'earn', 'ease', 'east', 'easy', 'echo', 'edge', 'eel',
  'egg', 'elk', 'elm', 'end', 'even', 'ever', 'exam', 'exit', 'face', 'fact', 'fair',
  'fall', 'fan', 'farm', 'fast', 'fawn', 'feed', 'feel', 'fern', 'fig', 'file', 'fill',
  'film', 'fin', 'find', 'fine', 'fire', 'firm', 'fish', 'fit', 'five', 'flag', 'flat',
  'flax', 'flow', 'fly', 'foam', 'fold', 'folk', 'food', 'foot', 'fork', 'form', 'fort',
  'four', 'fox', 'free', 'frog', 'fuel', 'full', 'fun', 'fur', 'gain', 'game', 'gap',
  'gate', 'gear', 'gem', 'gift', 'give', 'glad', 'glow', 'glue', 'goal', 'goat', 'gold',
  'golf', 'good', 'grab', 'gray', 'grid', 'grin', 'grip', 'grow', 'gull', 'gum', 'gust',
  'hail', 'hair', 'half', 'hall', 'halo', 'hand', 'hare', 'harp', 'hat', 'hawk', 'hay',
  'head', 'heap', 'hear', 'heat', 'heel', 'held', 'help', 'hen', 'herb', 'hero', 'hide',
  'high', 'hike', 'hill', 'hint', 'hive', 'hold', 'home', 'hood', 'hook', 'hope', 'horn',
  'host', 'hour', 'hug', 'hull', 'hum', 'hut', 'ice', 'icon', 'idea', 'idle', 'inch',
  'ink', 'iris', 'iron', 'isle', 'item', 'ivy', 'jade', 'jam', 'jar', 'jaw', 'jazz',
  'jeep', 'jet', 'join', 'joke', 'joy', 'jump', 'June', 'July', 'keep', 'kelp', 'key',
  'kick', 'kid', 'kind', 'king', 'kiss', 'kit', 'kite', 'kiwi', 'knee', 'knit', 'knot',
  'lake', 'lamb', 'lamp', 'land', 'lane', 'lap', 'lark', 'last', 'late', 'lava', 'lawn',
  'leaf', 'lean', 'leap', 'left', 'leg', 'lend', 'lens', 'lift', 'lime', 'line', 'link',
  'lion', 'list', 'live', 'load', 'loaf', 'lock', 'log', 'long', 'look', 'loop', 'love',
  'luck', 'lump', 'lynx', 'made', 'mail', 'main', 'make', 'map', 'mark', 'mast',
  'mate', 'maze', 'meal', 'meet', 'melt', 'menu', 'mesh', 'mild', 'mile', 'milk', 'mill',
  'mind', 'mint', 'mist', 'mix', 'mode', 'moon', 'moss', 'moth', 'move', 'mug', 'mule',
  'name', 'navy', 'near', 'neat', 'nest', 'net', 'new', 'next', 'nice', 'nine', 'node',
  'noon', 'nose', 'note', 'nova', 'nut', 'oak', 'oar', 'oat', 'oil', 'once', 'open',
  'opal', 'oval', 'oven', 'owl', 'pace', 'pack', 'page', 'pair', 'palm', 'pan', 'park',
  'part', 'path', 'paw', 'peak', 'pear', 'peel', 'pen', 'pet', 'pick', 'pie', 'pier',
  'pig', 'pike', 'pile', 'pine', 'pink', 'pipe', 'plan', 'play', 'plum', 'pod', 'pond',
  'pony', 'pool', 'port', 'pose', 'post', 'pot', 'pour', 'pull', 'puma', 'pure', 'push',
  'quiz', 'race', 'raft', 'rail', 'rain', 'rake', 'ramp', 'rare', 'ray', 'read', 'reed',
  'reef', 'rest', 'rice', 'ride', 'ring', 'rise', 'road', 'roam', 'robe', 'rock', 'roll',
  'roof', 'room', 'root', 'rope', 'rose', 'row', 'ruby', 'rug', 'rule', 'run', 'rush',
  'safe', 'sage', 'sail', 'salt', 'sand', 'save', 'seal', 'seat', 'seed', 'seek', 'self',
  'send', 'shed', 'ship', 'shoe', 'shop', 'show', 'side', 'sign', 'silk', 'sing', 'sink',
  'sip', 'site', 'size', 'ski', 'skin', 'skip', 'sky', 'sled', 'slim', 'slow', 'snap',
  'snow', 'soap', 'sock', 'sofa', 'soft', 'soil', 'song', 'soon', 'sort', 'soup', 'span',
  'spin', 'spot', 'star', 'stay', 'stem', 'step', 'stir', 'stop', 'sun', 'surf', 'swan',
  'swim', 'tail', 'take', 'tale', 'talk', 'tall', 'tame', 'tank', 'tap', 'task', 'taxi',
  'tea', 'team', 'tear', 'tell', 'ten', 'tent', 'term', 'test', 'text', 'thin', 'tick',
  'tide', 'tidy', 'tile', 'time', 'tin', 'tiny', 'tip', 'toe', 'tone', 'tool', 'top',
  'toss', 'town', 'toy', 'tram', 'tray', 'tree', 'trim', 'trip', 'true', 'tuba', 'tube',
  'tune', 'turn', 'twin', 'type', 'unit', 'upon', 'urge', 'use', 'vase', 'vast', 'veil',
  'vent', 'very', 'vest', 'view', 'vine', 'vote', 'wade', 'wake', 'walk', 'wall', 'wand',
  'warm', 'wash', 'wave', 'wax', 'way', 'web', 'weed', 'week', 'well', 'west', 'wide',
  'wild', 'will', 'wind', 'wing', 'wink', 'wire', 'wise', 'wish', 'wolf', 'wood', 'wool',
  'word', 'work', 'wrap', 'wren', 'yard', 'yarn', 'year', 'yell', 'yoga', 'yolk', 'zero',
  'zest', 'zinc', 'zip', 'zone', 'zoom',
].map(word => word.toLowerCase()));

const SPECIAL_CHARACTERS = '!@#$%*?';

/** Generates a new password only; saving it is the caller's responsibility. */
export function generateCredentialPassword(): string {
  const firstIndex = randomInt(CREDENTIAL_PASSWORD_WORDS.length);
  // Sample the second word without replacement, without a retry loop or bias.
  const secondIndex = randomInt(CREDENTIAL_PASSWORD_WORDS.length - 1);
  const first = CREDENTIAL_PASSWORD_WORDS[firstIndex]!;
  const second = CREDENTIAL_PASSWORD_WORDS[secondIndex >= firstIndex ? secondIndex + 1 : secondIndex]!;
  const special = SPECIAL_CHARACTERS[randomInt(SPECIAL_CHARACTERS.length)]!;
  const digits = randomInt(100).toString().padStart(2, '0');
  return `${first[0]!.toUpperCase()}${first.slice(1)}${special}${second}${digits}`;
}
