Feature: Calculate one employee's frozen daily commission snapshot, attributed only through the assignment table

  Scenario: A driver's delivered shipments for the day produce a calculated commission row
    Given an hr.commission_rules row for this entity, applies_to "driver", tier_from 0, tier_to null, rate_per_unit set, valid window covering today
    And an active imile.driver_id_assignments row for this employee covering today
    And three imile.shipments rows attributed to this employee's driver_id via imile.shipments_attributed, internal_status "delivered", ofd_at today
    When CalculateDailyCommission is called for this employee and today
    Then one hr.commission_daily row is inserted with delivered_count 3, status "calculated", driver_id_ref set to the active assignment's driver_id
    And gross_commission equals 3 times rate_per_unit (or min_daily if greater)
    And source_snapshot and rule_snapshot are both populated
    And one platform.audit_log row is written for the insert

  Scenario: A second calculation for the same employee and day is rejected
    Given an hr.commission_daily row already exists for this employee and today
    When CalculateDailyCommission is called again for the same employee and today
    Then the command fails with a mapped CommissionAlreadyCalculatedError (the DB's own unique (work_date, employee_id) violation, translated) and no new row is written

  Scenario: No applicable commission rule fails clearly
    Given no hr.commission_rules row matches this employee's entity, tier, and valid window for today
    When CalculateDailyCommission is called
    Then the command fails with a mapped NoApplicableCommissionRuleError and no row is written

  Scenario: A shipment attributed via a stale direct driver_code join is never counted — only the assignment-table view is trusted
    Given an imile.shipments row whose driver_code matches a driver_ids row, but that driver_id has NO imile.driver_id_assignments row covering the shipment's ofd_at (a lapsed or never-assigned code)
    When CalculateDailyCommission is called for the employee who currently holds that driver_id (if any) for today
    Then that shipment is NOT counted in delivered_count/failed_count/returned_count (it is invisible through imile.shipments_attributed, same as imile.verify_attribution() would flag it as unattributed)

  Scenario: An outsider (non-internal) cannot trigger a calculation
    Given a non-internal actor
    When CalculateDailyCommission is called
    Then the command is refused and no row is written
