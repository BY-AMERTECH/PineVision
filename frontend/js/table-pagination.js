(function () {
  const ROWS_PER_PAGE = 10;

  function paginate(rows, page) {
    const totalRows = rows.length;
    const totalPages = Math.ceil(totalRows / ROWS_PER_PAGE);
    const currentPage = totalPages
      ? Math.min(Math.max(1, page || 1), totalPages)
      : 1;
    const startIndex = (currentPage - 1) * ROWS_PER_PAGE;

    return {
      rows: rows.slice(startIndex, startIndex + ROWS_PER_PAGE),
      currentPage: currentPage,
      totalPages: totalPages,
      totalRows: totalRows,
      firstRow: totalRows ? startIndex + 1 : 0,
      lastRow: Math.min(startIndex + ROWS_PER_PAGE, totalRows),
    };
  }

  function render(container, pageData, itemLabel, onPageChange) {
    if (!container) return;
    if (pageData.totalRows <= ROWS_PER_PAGE) {
      container.innerHTML = "";
      return;
    }

    const pageNumbers = new Set([1, pageData.totalPages]);
    for (
      let page = pageData.currentPage - 1;
      page <= pageData.currentPage + 1;
      page++
    ) {
      if (page > 1 && page < pageData.totalPages) pageNumbers.add(page);
    }
    const sortedPages = Array.from(pageNumbers).sort(function (a, b) {
      return a - b;
    });

    let pageButtons = "";
    let previousPage = 0;
    sortedPages.forEach(function (page) {
      if (previousPage && page - previousPage > 1) {
        pageButtons += '<span class="table-pagination-ellipsis" aria-hidden="true">…</span>';
      }
      const active = page === pageData.currentPage;
      pageButtons +=
        '<button type="button" class="btn btn-secondary btn-sm table-pagination-button' +
        (active ? " is-active" : "") +
        '" data-page="' +
        page +
        '" aria-label="Go to page ' +
        page +
        '"' +
        (active ? ' aria-current="page"' : "") +
        ">" +
        page +
        "</button>";
      previousPage = page;
    });

    container.innerHTML =
      '<nav class="table-pagination" aria-label="Table pagination">' +
      '<span class="table-pagination-summary" aria-live="polite">Showing ' +
      pageData.firstRow +
      "-" +
      pageData.lastRow +
      " of " +
      pageData.totalRows +
      " " +
      itemLabel +
      "</span>" +
      '<div class="table-pagination-controls">' +
      '<button type="button" class="btn btn-secondary btn-sm table-pagination-button" data-page="' +
      (pageData.currentPage - 1) +
      '" aria-label="Previous page"' +
      (pageData.currentPage === 1 ? " disabled" : "") +
      ">Previous</button>" +
      pageButtons +
      '<button type="button" class="btn btn-secondary btn-sm table-pagination-button" data-page="' +
      (pageData.currentPage + 1) +
      '" aria-label="Next page"' +
      (pageData.currentPage === pageData.totalPages ? " disabled" : "") +
      ">Next</button>" +
      "</div></nav>";

    container.querySelectorAll("button[data-page]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.disabled) return;
        onPageChange(Number(button.dataset.page));
      });
    });
  }

  window.TablePagination = {
    ROWS_PER_PAGE: ROWS_PER_PAGE,
    paginate: paginate,
    render: render,
  };
})();
