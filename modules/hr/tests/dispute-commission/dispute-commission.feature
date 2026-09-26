Feature: Dispute and confirm a driver's daily commission, delivery-supervisor SoD enforced

  Scenario: A driver disputes their own calculated commission within the 48-hour window
    Given a calculated hr.commission_daily row created less than 48 hours ago, for this employee
    When DisputeCommission is called by that employee's own actor, with a dispute_note
    Then the row's status becomes "disputed", dispute_note and disputed_at are recorded
    And one platform.audit_log row is written

  Scenario: A dispute after the 48-hour window is rejected
    Given a calculated hr.commission_daily row created more than 48 hours ago
    When DisputeCommission is called by that employee's own actor
    Then the command fails with a mapped DisputeWindowExpiredError and no row is written
