-]\# Fieldnote business manager

A lightweight, local-first business manager for customers, products, sales, expenses, and reports. It uses Python's standard library and SQLite, so there are no package installs or external services required.

## Run it

1. Install Python 3.10 or newer.
2. From this folder, run `python app.py`.
3. Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

The SQLite database is created as `business.db` next to `app.py` the first time the application starts. Keep the app running while you use it. It listens only on your own computer.

## Features

- Customer records with contact details and order counts.
- Product catalog with unique SKUs, prices, cost, and stock levels.
- Sales with multiple products, customer selection, automatic totals, and stock deduction.
- Expense tracking with category and date.
- Dashboard KPIs, recent sales, revenue chart, and low-stock reminders.
- Date-range reports for revenue, gross profit, expenses, net profit, and average order value.
- Search across records and category/date filters; edit and delete supported records.
- Deleting a sale restores its sold quantities to stock. Products already used in a sale cannot be deleted.

All monetary values are displayed in South African rand (ZAR). This is intended for a single local business and does not include authentication, online hosting, or tax handling.
