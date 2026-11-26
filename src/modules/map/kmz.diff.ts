import { styleKey, type ParsedFeature } from './kmz.parser.js'

export type FeatureState = 'kept' | 'changed' | 'added' | 'removed'

/** A feature that is already saved (same shape as OldFeature in kmz.routes.ts) */
export type OldLike = {
  name: string | null
  category: string | null
  geomType: string
  coordinates: unknown
  style: string
}

export type RemovedSample = { name: string | null; category: string | null; geom_type: string }

export type Box = [number, number, number, number]

const exactKey = (f: { name: string | null; category: string | null; geomType: string; coordinates: unknown; style?: string }) =>
  JSON.stringify([f.name ?? '', f.category ?? '', f.geomType, f.coordinates, f.style ?? ''])

const placeKey = (geomType: string, coordinates: unknown) => JSON.stringify([geomType, coordinates])

const push = (m: Map<string, number[]>, k: string, i: number) => {
  const l = m.get(k)
  if (l) l.push(i)
  else m.set(k, [i])
}

const take = (m: Map<string, number[]>, k: string) => m.get(k)?.shift()

/**
 * Object-by-object comparison between the saved data and the file.
 * Same rules (and so the same counts) as assess() in kmz.routes.ts:
 *   1) identical name + category + type + coordinates + style = kept
 *   2) same type and place, but other name/category/style     = changed
 *   3) everything else is added (file) or removed (saved)
 */
export function diffFeatures(old: OldLike[], neu: ParsedFeature[]) {
  const oldState: (FeatureState | null)[] = old.map(() => null)
  const newState: FeatureState[] = neu.map((): FeatureState => 'added')

  const exact = new Map<string, number[]>()
  old.forEach((f, i) => push(exact, exactKey(f), i))
  const left: number[] = []
  neu.forEach((f, i) => {
    const j = take(
      exact,
      exactKey({ name: f.name, category: f.category, geomType: f.geomType, coordinates: f.geometry.coordinates, style: styleKey(f.style) }),
    )
    if (j === undefined) left.push(i)
    else {
      oldState[j] = 'kept'
      newState[i] = 'kept'
    }
  })

  const place = new Map<string, number[]>()
  old.forEach((f, i) => {
    if (oldState[i] === null) push(place, placeKey(f.geomType, f.coordinates), i)
  })
  for (const i of left) {
    const j = take(place, placeKey(neu[i].geomType, neu[i].geometry.coordinates))
    if (j === undefined) newState[i] = 'added'
    else {
      oldState[j] = 'changed'
      newState[i] = 'changed'
    }
  }

  return { oldStates: oldState.map((s): FeatureState => s ?? 'removed'), newStates: newState }
}

/** A few of the items that will be deleted. Items with a name come first: "Pole 045" says more than "Unnamed point". */
export function removedSamples(old: OldLike[], neu: ParsedFeature[], limit = 8): RemovedSample[] {
  const { oldStates } = diffFeatures(old, neu)
  const gone = old.filter((_, i) => oldStates[i] === 'removed')
  const unnamed = (f: OldLike) => (f.name === null || f.name === '' ? 1 : 0)
  gone.sort((a, b) => unnamed(a) - unnamed(b))
  return gone.slice(0, limit).map((f) => ({ name: f.name, category: f.category, geom_type: f.geomType }))
}

/** bounding box of any GeoJSON coordinates: [minX, minY, maxX, maxY] */
export function bboxOf(coords: unknown, box: Box = [180, 90, -180, -90]): Box {
  if (Array.isArray(coords) && typeof coords[0] === 'number') {
    const [x, y] = coords as number[]
    box[0] = Math.min(box[0], x)
    box[1] = Math.min(box[1], y)
    box[2] = Math.max(box[2], x)
    box[3] = Math.max(box[3], y)
  } else if (Array.isArray(coords)) {
    for (const c of coords) bboxOf(c, box)
  }
  return box
}