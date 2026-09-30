Feature: PDA pick, check and load screens (WBS 2.16 part 3)
  Scenario: A scanned pick line queues one PickLine write with one Idempotency-Key and correlationId
  Scenario: A server refusal on a pick plays the error sound + vibration and states the next action
  Scenario: The user who picked the order is refused on the check screen with the next action
  Scenario: A user who did not pick the order checks it and one CheckOrder write is queued
  Scenario: Loading a packed order queues one LoadOrder write
  Scenario: /pick, /check and /load render their screens in all six locales, RTL for ar and ur
