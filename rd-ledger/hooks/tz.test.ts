import { describe, expect, test } from 'claude-code/testing'

import { addDays, dayBounds, detectZone, isoWeek, isoWithOffset, isZone, localDate, monthOfTs, previousMonth, weekDates, weekOfTs, zoneFromLocaltimeTarget } from './tz'

const NY = 'America/New_York'
const HOUR = 3_600_000

/** Every date of a year, by addDays from 1 January. */
const yearDates = (year: number): string[] => {
  const out: string[] = []
  for (let d = `${year}-01-01`; d.startsWith(String(year)); d = addDays(d, 1)) out.push(d)
  return out
}

describe('zone detection', () => {
  test('detectZone: absent, throwing or garbage Intl gives null; the real one gives a zone isZone accepts', async () => {
    expect(detectZone(undefined)).toBeNull()
    const throwing = { DateTimeFormat: function () { throw new Error('no zone data') } } as unknown as typeof Intl
    expect(detectZone(throwing)).toBeNull()
    const garbage = { DateTimeFormat: function () { return { resolvedOptions: () => ({ timeZone: 'not a zone' }) } } } as unknown as typeof Intl
    expect(detectZone(garbage)).toBeNull()
    const blank = { DateTimeFormat: function () { return { resolvedOptions: () => ({}) } } } as unknown as typeof Intl
    expect(detectZone(blank)).toBeNull()
    const real = detectZone()
    expect(real === null || isZone(real)).toBe(true)
  })

  test('isZone: Intl decides, the shape is one line of ASCII without spaces, at most 64 chars', async () => {
    expect(isZone('Nope/Zone')).toBe(false)
    expect(isZone(NY)).toBe(true)
    expect(isZone('Asia/Kolkata')).toBe(true)
    expect(isZone('UTC')).toBe(true)
    expect(isZone('')).toBe(false)
    expect(isZone('America/New York')).toBe(false)
    expect(isZone('America/New_York\n')).toBe(false)
    expect(isZone('../etc/passwd')).toBe(false)
    expect(isZone(`America/${'A'.repeat(60)}`)).toBe(false)
    expect(isZone(NY, undefined)).toBe(false)
  })

  test('zoneFromLocaltimeTarget reads the zone after /zoneinfo/ and refuses anything else', async () => {
    expect(zoneFromLocaltimeTarget('/var/db/timezone/zoneinfo/America/New_York')).toBe(NY)
    expect(zoneFromLocaltimeTarget('/usr/share/zoneinfo/posix/Europe/London')).toBe('Europe/London')
    expect(zoneFromLocaltimeTarget('../usr/share/zoneinfo/Asia/Kolkata')).toBe('Asia/Kolkata')
    expect(zoneFromLocaltimeTarget('garbage')).toBeNull()
    expect(zoneFromLocaltimeTarget('/var/db/timezone/zoneinfo/Nope/Zone')).toBeNull()
    expect(zoneFromLocaltimeTarget('/var/db/timezone/zoneinfo/../../etc/passwd')).toBeNull()
    expect(zoneFromLocaltimeTarget('/var/db/timezone/zoneinfo/America/New_York\nx')).toBeNull()
    expect(zoneFromLocaltimeTarget('')).toBeNull()
  })
})

describe('calendar', () => {
  test('ISO week edges and week dates', async () => {
    expect(isoWeek('2025-12-29')).toBe('2026-W01')
    expect(isoWeek('2027-01-01')).toBe('2026-W53')
    expect(isoWeek('2027-01-04')).toBe('2027-W01')
    expect(isoWeek('2026-10-11')).toBe('2026-W41')
    expect(isoWeek('2026-10-12')).toBe('2026-W42')
    expect(weekDates('2026-W41')).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'])
    expect(weekDates('2026-W01')[0]).toBe('2025-12-29')
    expect(weekDates('2026-W53')[6]).toBe('2027-01-03')
    expect(weekDates('2027-W53')).toEqual([])
    expect(weekDates('2026-W00')).toEqual([])
    expect(weekDates('junk')).toEqual([])
    for (const d of yearDates(2026)) expect(weekDates(isoWeek(d))).toContain(d)
  })

  test('addDays, previousMonth across year and leap boundaries', async () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29')
    expect(addDays('2026-10-11', -7)).toBe('2026-10-04')
    expect(addDays('2026-10-11', 0)).toBe('2026-10-11')
    expect(previousMonth('2026-01')).toBe('2025-12')
    expect(previousMonth('2026-10')).toBe('2026-09')
    expect(() => addDays('2026-02-30', 1)).toThrow()
  })
})

describe('instants in a zone', () => {
  test('a sweep over every 2026 date in New York: 24 h days except 23 h on 03-08 and 25 h on 11-01', async () => {
    const odd: Record<string, number> = {}
    for (const d of yearDates(2026)) {
      const { startTs, endTs } = dayBounds(d, NY)
      expect(localDate(startTs, NY)).toBe(d)
      expect(localDate(startTs - 1000, NY)).toBe(addDays(d, -1))
      expect(localDate(endTs - 1000, NY)).toBe(d)
      if (endTs - startTs !== 86_400_000) odd[d] = endTs - startTs
    }
    expect(odd).toEqual({ '2026-03-08': 82_800_000, '2026-11-01': 90_000_000 })
    expect(dayBounds('2026-03-08', NY)).toEqual({ startTs: Date.UTC(2026, 2, 8, 5), endTs: Date.UTC(2026, 2, 9, 4) })
  })

  test('a zone whose midnight is skipped and a half-hour zone still give contiguous days that start on their own date', async () => {
    for (const zone of ['America/Santiago', 'Asia/Kolkata', 'Australia/Lord_Howe']) {
      let prevEnd: number | null = null
      for (const d of yearDates(2026)) {
        const { startTs, endTs } = dayBounds(d, zone)
        expect(localDate(startTs, zone)).toBe(d)
        expect(localDate(startTs - 1000, zone)).toBe(addDays(d, -1))
        expect(endTs - startTs >= 22 * HOUR && endTs - startTs <= 26 * HOUR).toBe(true)
        if (prevEnd !== null) expect(startTs).toBe(prevEnd)
        prevEnd = endTs
      }
    }
  })

  test('Asia/Kolkata (+05:30) dates an instant near midnight by the local clock', async () => {
    expect(localDate(Date.UTC(2026, 9, 10, 18, 29, 59), 'Asia/Kolkata')).toBe('2026-10-10')
    expect(localDate(Date.UTC(2026, 9, 10, 18, 30, 0), 'Asia/Kolkata')).toBe('2026-10-11')
    expect(isoWithOffset(Date.UTC(2026, 9, 10, 18, 30, 0), 'Asia/Kolkata')).toBe('2026-10-11T00:00:00+05:30')
  })

  test('isoWithOffset renders -04:00 in EDT and -05:00 in EST, whole seconds', async () => {
    expect(isoWithOffset(Date.UTC(2026, 9, 11, 13, 0, 0, 999), NY)).toBe('2026-10-11T09:00:00-04:00')
    expect(isoWithOffset(Date.UTC(2026, 11, 1, 14, 0, 0), NY)).toBe('2026-12-01T09:00:00-05:00')
    expect(isoWithOffset(Date.UTC(2026, 10, 1, 5, 30), NY)).toBe('2026-11-01T01:30:00-04:00')
    expect(isoWithOffset(Date.UTC(2026, 10, 1, 6, 30), NY)).toBe('2026-11-01T01:30:00-05:00')
    expect(isoWithOffset(Date.UTC(2026, 0, 1), 'UTC')).toBe('2026-01-01T00:00:00+00:00')
  })

  test('week and month of an instant follow the local date', async () => {
    // 2026-10-12T03:30Z is still Sunday 10-11 in New York.
    expect(weekOfTs(Date.UTC(2026, 9, 12, 3, 30), NY)).toBe('2026-W41')
    expect(weekOfTs(Date.UTC(2026, 9, 12, 4, 0), NY)).toBe('2026-W42')
    expect(monthOfTs(Date.UTC(2026, 10, 1, 3, 59), NY)).toBe('2026-10')
    expect(monthOfTs(Date.UTC(2026, 10, 1, 4, 0), NY)).toBe('2026-11')
  })
})
