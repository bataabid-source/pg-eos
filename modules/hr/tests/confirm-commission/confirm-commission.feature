Feature: Dispute and confirm a driver's daily commission, delivery-supervisor SoD enforced

  Scenario: A DEL_SUP actor resolves a dispute by confirming it
    Given a disputed hr.commission_daily row
    When ConfirmCommission is called by a DEL_SUP actor who is NOT the disputing employee
    Then the row's status becomes "confirmed", confirmed_by/confirmed_at are recorded, payroll_period is set to the work_date's own month
    And one platform.audit_log row is written

  Scenario: The disputing driver cannot confirm their own dispute (SoD)
    Given a disputed hr.commission_daily row
    When ConfirmCommission is called by the SAME employee who raised the dispute
    Then the command fails with a mapped SelfReviewNotAllowedError and no row is written (both the application-level check and, if bypassed, hr.guard_commission_daily_status()'s own trigger check must independently refuse this)

  Scenario: A calculated row past its dispute window can be confirmed directly (the auto-confirm path, invoked here as an explicit call, not yet scheduled)
    Given a calculated hr.commission_daily row created more than 48 hours ago, never disputed
    When ConfirmCommission is called by a DEL_SUP actor (or a system/internal actor representing the not-yet-built scheduler)
    Then the row's status becomes "confirmed" directly from "calculated" (skipping "disputed"), payroll_period is set

  Scenario: A calculated row still inside its dispute window cannot be confirmed yet
    Given a calculated hr.commission_daily row created less than 48 hours ago, never disputed
    When ConfirmCommission is called
    Then the command fails with a mapped DisputeWindowStillOpenError and no row is written
