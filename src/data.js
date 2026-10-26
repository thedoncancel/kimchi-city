// shop: where it is sold (mart = K-Mart, boutique = Maison K, watch = Chrono Row)
// req: friends may ask for it as their daily favor
export const ITEMS = {
  banana:  { name: 'Banana Milk',  price: 3,  type: 'food',  energy: 15, icon: '🍌', shop: 'mart', req: true },
  kimbap:  { name: 'Kimbap',       price: 5,  type: 'food',  energy: 25, icon: '🍙', shop: 'mart', req: true },
  ramen:   { name: 'Kimchi Ramen', price: 6,  type: 'food',  energy: 35, icon: '🍜', shop: 'mart', req: true },
  tteok:   { name: 'Tteokbokki',   price: 10, type: 'food',  energy: 60, icon: '🌶️', shop: 'mart', req: true },
  flowers: { name: 'Flowers',      price: 40, type: 'gift',  icon: '💐', shop: 'mart', req: true },
  plushie: { name: 'Penguin Plushie', price: 35, type: 'gift', icon: '🐧', shop: 'mart', req: true },
  game:    { name: 'Video Game',   price: 70, type: 'gift',  icon: '🎮', shop: 'mart', req: true },
  omakase: { name: 'Omakase Dinner', price: 1200, type: 'food', energy: 75, icon: '🍣', shop: 'boutique' },
  caviar:  { name: 'Caviar & Champagne', price: 2600, type: 'food', energy: 100, icon: '🥂', shop: 'boutique' },
  tote:    { name: 'Woven Leather Tote', price: 6200, type: 'gift', icon: '👜', shop: 'boutique', lux: true },
  trunk:   { name: 'Monogram Trunk Bag', price: 9800, type: 'gift', icon: '🧳', shop: 'boutique', lux: true },
  croc:    { name: 'Croc Handbag', price: 48000, type: 'gift', icon: '👛', shop: 'boutique', lux: true },
  cap:     { name: 'Designer Cap', price: 650,  type: 'style', icon: '🧢', shop: 'boutique' },
  shades:  { name: 'Black Shades', price: 890,  type: 'style', icon: '🕶️', shop: 'boutique' },
  chain:   { name: 'Gold Chain',   price: 18500, type: 'style', icon: '📿', shop: 'boutique' },
  fit_denim:  { name: 'Denim Set',        price: 3400, type: 'fit', icon: '🧥', shop: 'boutique', outfit: 'denim', desc: 'Trucker jacket, white tee' },
  fit_hoodie: { name: 'Red Jet Hoodie',   price: 1600, type: 'fit', icon: '❤️', shop: 'boutique', outfit: 'hoodie', desc: 'For the private jet' },
  fit_black:  { name: 'All-Black Bomber', price: 4200, type: 'fit', icon: '🖤', shop: 'boutique', outfit: 'black', desc: 'Night-out fit' },
  w_steel:   { name: 'Steel Diver',          price: 14000,  type: 'watch', icon: '⌚', shop: 'watch', look: 'steel', desc: 'The daily one' },
  w_octa:    { name: 'Octagon Gold',         price: 96000,  type: 'watch', icon: '🟡', shop: 'watch', look: 'gold', desc: 'Integrated bracelet, solid gold' },
  w_skel:    { name: 'Skeleton Tourbillon',  price: 340000, type: 'watch', icon: '🦴', shop: 'watch', look: 'skeleton', desc: 'Carbon case, see-through dial' },
  w_rainbow: { name: 'Rainbow Chrono',       price: 680000, type: 'watch', icon: '🌈', shop: 'watch', look: 'rainbow', desc: 'Sapphire rainbow bezel' },
};

// The luxury cars are parodies of the ones in Kimchi's posts (GTA style: no real brands).
export const CAR_TYPES = {
  hatch:  { name: 'Hatchback',    price: 300,  len: 58, wid: 30, max: 430, acc: 380, turn: 2.8, color: '#3b7dd8' },
  sedan:  { name: 'Sedan',        price: 450,  len: 66, wid: 31, max: 480, acc: 400, turn: 2.6, color: '#2f2f33' },
  taxi:   { name: 'Taxi',         price: 500,  len: 66, wid: 31, max: 490, acc: 410, turn: 2.6, color: '#f2c230' },
  van:    { name: 'Delivery Van', price: 550,  len: 76, wid: 36, max: 370, acc: 310, turn: 2.2, color: '#ece7dc' },
  sports: { name: 'Sports Car',   price: 1500, len: 68, wid: 32, max: 740, acc: 680, turn: 3.2, color: '#d6402b' },
  police: { name: 'Police Cruiser', price: 0, len: 70, wid: 32, max: 620, acc: 560, turn: 2.9, color: '#f4f4f2' },
  ursa:      { name: 'Toro Ursa',       price: 245000,  len: 80, wid: 34, max: 700, acc: 640, turn: 2.8, color: '#121316', lux: true, tag: 'Super SUV' },
  gwagen:    { name: 'Gelände 63',      price: 189000,  len: 74, wid: 34, max: 560, acc: 520, turn: 2.5, color: '#f1f0ec', lux: true, tag: 'Boxy legend' },
  monarch:   { name: 'Monarch S680',    price: 236000,  len: 84, wid: 33, max: 620, acc: 520, turn: 2.4, color: '#141518', color2: '#b8bcc3', lux: true, tag: 'Two-tone limo' },
  phantasma: { name: 'Royce Phantasma', price: 525000,  len: 92, wid: 35, max: 580, acc: 470, turn: 2.2, color: '#3a3e44', lux: true, tag: 'Ultra luxury' },
  cavallo:   { name: 'Cavallo 812',     price: 418000,  len: 76, wid: 33, max: 860, acc: 820, turn: 3.3, color: '#8b9097', lux: true, tag: 'V12 grand tourer' },
  papaya:    { name: 'Papaya 750S',     price: 332000,  len: 72, wid: 33, max: 880, acc: 860, turn: 3.4, color: '#3d1a66', lux: true, tag: 'Supercar' },
  bolide:    { name: 'Bolide Chiro',    price: 3200000, len: 75, wid: 34, max: 980, acc: 900, turn: 3.2, color: '#7a0f16', color2: '#101012', lux: true, tag: 'Hypercar' },
};
export const DEALER = ['gwagen', 'monarch', 'ursa', 'papaya', 'cavallo', 'phantasma', 'bolide'];
export const LUX_CARS = DEALER;
export const CAR_COLORS = ['#3b7dd8', '#e9e4da', '#2f2f33', '#c9c9c9', '#d6402b', '#3c8d5a', '#8a5cc2', '#e3843a', '#1f4f8a', '#7a8a94'];
// the paint you can get at K-Spray on a luxury car: Kimchi's taste runs dark
export const LUX_COLORS = ['#121316', '#0b0b0d', '#3a3e44', '#8b9097', '#f1f0ec', '#3d1a66', '#1d2b4a', '#7a0f16', '#2e3b2e', '#c9c2b3'];

// lines: what each friend says on any map. v2Lines: more about the Kimchi Key's places (docs/map-v2-spec.md
// §2, §5), said there as well (the 3D game adds them to lines on the Key; see src/3d/missions.js).
export const FRIENDS = [
  {
    id: 'mochi', name: 'Mochi', home: 'park', likes: 'banana',
    look: { skin: '#f3d2b3', hair: '#2b1d17', shirt: '#f29bb8', pants: '#3a3a48', long: true },
    lines: [
      'Yo Kimchi! The park is so chill today.',
      'Banana milk is the best drink. Don\'t argue. Not even champagne beats it.',
      'I saw a kimchi jar hiding near the road. Go find it!',
      'Your Ursa is SO clean. Take me for a drive later?',
    ],
    v2Lines: [
      'The fountain on Seoul Circle is basically my office now.',
      'Neon Alley lights up after dark. Bring your camera. 📸',
      'Have you been up to the KIMCHI letters? You can see the whole Key from there.',
    ],
  },
  {
    id: 'bao', name: 'Bao', home: 'mart', likes: 'tteok',
    look: { skin: '#e8b98f', hair: '#121212', shirt: '#4caf7a', pants: '#2d3a4f' },
    lines: [
      'K-Mart tteokbokki is fire. Even rich people eat here. You do.',
      'Heard Kimchi House pays good tips for fast deliveries.',
      'Bro your fit is clean today. Is that the denim set?',
      'You posted from a private jet AGAIN? Take me next time.',
    ],
    v2Lines: [
      'People saw Red Bandanas out by the airboats in the Glades. Sketchy, bro.',
      'K-Spray down at the Port will paint anything. Even a cop magnet like your car.',
      'The tteokbokki stand at Kimchi Fest is almost as good as ours. Almost.',
    ],
  },
  {
    id: 'yuna', name: 'Yuna', home: 'yuna', likes: 'tote',
    look: { skin: '#f6d7bf', hair: '#5a3424', shirt: '#9b7be0', pants: '#2b2b3a', long: true },
    lines: [
      'Kimchi! Want to come in for tea sometime?',
      'I love flowers. And woven leather totes. Just saying...',
      'The city looks so pretty at night. Perfect for photos.',
      'Your last post got how many views?! 😳',
    ],
    v2Lines: [
      'The Gables are so quiet. Just me and the banyans.',
      'Sunset at the Yacht Club on South Pointe is unreal. Golden hour, trust me.',
      'Have you seen the lighthouse on Cape Kimchi at night? So romantic.',
    ],
  },
  {
    id: 'dex', name: 'Dex', home: 'dealer', likes: 'game',
    look: { skin: '#c98d63', hair: '#d9c27a', shirt: '#f08a2c', pants: '#1f2b3a' },
    lines: [
      'The Bolide Chiro? Zero to sixty in like two seconds. Three point two million.',
      'Become my best friend and I\'ll get you a dealer discount at Kimchi Motors.',
      'Handbrake turns, Kimchi. Hold Space. Trust.',
      'A grey Cavallo with red seats. That\'s the one. Ask me how I know.',
    ],
    v2Lines: [
      'One lap of the Kimchi Loop in under two minutes. That\'s the bar.',
      'Take the Runway Straight flat out. Brake for nothing. Okay, maybe for planes.',
      'The switchbacks down from Coral Heights at sunrise? Best road on the Key.',
    ],
  },
];

export const FAN_LINES = [
  'Is that Kimchi?!', 'OMG Kimchi!!', 'Can I get a selfie?', 'Love your posts!', 'Kimchi!! 🔥',
  'Big fan!', 'Yo it\'s Kimchi!', 'Following you on X!', 'Is that the rainbow watch?!', 'When\'s the next vlog?',
  'project kimchi 🔥', 'Your car collection is insane',
];
export const PED_LINES = ['Nice day huh', 'Where\'s the bus...', 'I need coffee', 'Hmm hmm hmm ♪', 'Late again...'];
export const SCARED_LINES = ['Yikes!', 'Whoa!', 'Hey!!', 'Watch it!', 'AAAH!'];
export const HIT_LINES = ['Ow!! Watch it!', 'Are you crazy?!', 'My back!!', 'Learn to drive!', 'Kimchi why?!'];
export const CARJACK_LINES = ['MY CAR!!', 'Hey that\'s mine!', 'Not again...', 'Someone stop him!'];
export const KNOCK_LINES = [
  'Nobody\'s home.', '"Go away, I\'m sleeping!"', '"We don\'t want any!"', '"Who is it?" ...silence.',
  '"Kimchi?? Come back later!"', 'A dog barks inside. 🐶', '"Is that my delivery?" ...nope.',
];
