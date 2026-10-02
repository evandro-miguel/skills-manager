#!/usr/bin/env bun

export function todayUtc(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
