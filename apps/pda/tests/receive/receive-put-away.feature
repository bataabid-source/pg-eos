Feature: PDA receive and put-away screens (WBS 2.16 part 2)
  Scenario: Scanning SKU, batch and expiry enqueues one receive-line command with one Idempotency-Key
  Scenario: A refused scan plays the error signal and shows the next action, and nothing is enqueued
  Scenario: Put-away shows the suggested location and confirms it by scanning the location code
  Scenario: Offline, both screens keep working and the unsynced counter rises
  Scenario: Every visible string resolves in ar, en, hi, ur, bn, am
