/**
 * Sample data used when MOCK_MODE=true so the whole portal can be demoed and
 * handed to a web developer WITHOUT live AroFlo credentials.
 *
 * Keyed by job number. Verification requires the job number, the client name AND the
 * post code to all match. Each quote carries a `businessUnit` ('major'|'minor') and an
 * optional `substatus` so the demo exercises BOTH workflow flows.
 *
 * Try these in the demo:
 *   Job 1048  +  Bradley Sandbox  +  3134  -> Minor mod, In progress
 *   Job 1070  +  Jane Doe         +  3000  -> Major mod, In progress (Awaiting OT approval)
 *   Job 2001  +  John Smith       +  3056  -> Major mod, Approved
 *   Job 3300  +  Pat Taylor       +  3220  -> Major mod, Not proceeding
 *   Job 119613 + Sristi Gurung    +  3044  -> Minor mod, booked with schedule details
 *   (any job number with the WRONG name or post code -> "couldn't verify" response)
 */
export const MOCK_JOBS = {
  '119613': {
    clientName: 'Sristi Gurung',
    locationName: '4, 138 Derby Street, Pascoe Vale',
    postcode: '3044',
    task: {
      status: 'Not Started',
      substatus: { substatus: 'Booked' },
      tasklocation: { locationname: '4, 138 Derby Street, Pascoe Vale' },
    },
    booking: {
      date: '2026/08/17',
      startTime: '09:45',
      endTime: '10:45',
      confirmedWindow: 'Confirmed 9–1',
      tradeName: 'Lee Taylor',
    },
    quotes: [
      {
        quoteName: '4, 138 Derby Street Pascoe Vale',
        businessUnit: 'minor',
        status: 'Approved',
        substatus: '',
        amountIncTax: '1157.37',
        dateCreated: '2026/08/10',
        dueDate: '2026/08/15',
        dateApproved: '2026/08/13',
        reference: 'CCGDVA7863',
      },
    ],
  },
  '1048': {
    clientName: 'Bradley Sandbox',
    postcode: '3134',
    quotes: [
      {
        quoteName: 'Bathroom grab rails & non-slip flooring',
        businessUnit: 'minor',
        status: 'In Progress',
        substatus: '',
        amountIncTax: '1840.50',
        dateCreated: '2026-05-29',
        dueDate: '2026-06-20',
        dateApproved: '',
        reference: 'MAM-1048',
      },
    ],
  },
  '1070': {
    clientName: 'Jane Doe',
    postcode: '3000',
    quotes: [
      {
        quoteName: 'Front entry modular access ramp',
        businessUnit: 'major',
        status: 'In Progress',
        substatus: 'Awaiting OT Approval - Non-Standard Plan',
        amountIncTax: '4114.08',
        dateCreated: '2026-05-18',
        dueDate: '2026-06-18',
        dateApproved: '',
        reference: 'MAM-1070',
      },
    ],
  },
  '2001': {
    clientName: 'John Smith',
    postcode: '3056',
    quotes: [
      {
        quoteName: 'Stair handrail + threshold ramps (whole home)',
        businessUnit: 'major',
        status: 'Approved',
        substatus: '',
        amountIncTax: '7650.00',
        dateCreated: '2026-04-30',
        dueDate: '2026-05-30',
        dateApproved: '2026-05-22',
        reference: 'MAM-2001',
      },
    ],
  },
  '3300': {
    clientName: 'Pat Taylor',
    postcode: '3220',
    quotes: [
      {
        quoteName: 'Bathroom level-access shower conversion',
        businessUnit: 'major',
        status: 'Rejected',
        substatus: 'Selected Another Builder - With Cancellation Fee',
        amountIncTax: '9200.00',
        dateCreated: '2026-03-11',
        dueDate: '2026-04-11',
        dateApproved: '',
        reference: 'MAM-3300',
      },
    ],
  },
};
